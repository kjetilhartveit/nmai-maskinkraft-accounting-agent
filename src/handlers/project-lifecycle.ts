import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findCustomerByName,
  findEmployeeByName,
  findEmployeeByEmail,
  getDefaultDepartmentId,
  getProjectManagerEmployeeId,
  today,
  ensureBankAccountConfigured,
  findOrCreateProduct,
} from "../lib/tripletex-helpers.js";
import { grantProjectManagerEntitlement } from "./create-employee.js";

/**
 * Full project lifecycle handler.
 *
 * Creates a project → registers hours → invoices the project.
 * Composes the logic of create_project + create_timesheet + create_invoice.
 */
export async function handleProjectLifecycle(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const projectName = String(entity.projectName ?? entity.name ?? "Prosjekt");
  const customerName = String(entity.customerName ?? entity.customer ?? "");
  const orgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
  const pmFirstName = String(entity.projectManagerFirstName ?? "");
  const pmLastName = String(entity.projectManagerLastName ?? "");
  const pmEmail = String(entity.projectManagerEmail ?? "");
  const budget = Number(entity.budget ?? 0);
  const hours = Number(entity.hours ?? 0);
  const activityName = String(entity.activityName ?? entity.activity ?? "Utvikling");
  const hourlyRate = Number(entity.hourlyRate ?? 0);
  const invoicePercentage = Number(entity.invoicePercentage ?? 100);

  // 1. Find or create customer
  let customerId: number | undefined;
  if (customerName) {
    customerId = ctx.getCustomerId(customerName);
    if (!customerId) {
      const existing = await findCustomerByName(client, customerName);
      if (existing) {
        customerId = existing.id;
      } else {
        const body: Record<string, unknown> = { name: customerName, isCustomer: true };
        if (orgNumber) body.organizationNumber = orgNumber;
        const created = await client.post<{ id: number }>("/customer", body);
        customerId = created.value.id;
      }
      ctx.registerCustomer(customerName, customerId);
    }
  }

  // 2. Resolve project manager
  let pmId: number | null = null;
  if (pmFirstName && pmLastName) {
    const ctxId = ctx.getEmployeeId(`${pmFirstName} ${pmLastName}`);
    if (ctxId) {
      pmId = ctxId;
    } else {
      const emp = await findEmployeeByName(client, pmFirstName, pmLastName);
      if (emp) pmId = emp.id;
    }
  }
  if (!pmId && pmEmail) {
    const emp = await findEmployeeByEmail(client, pmEmail);
    if (emp) pmId = emp.id;
  }
  if (!pmId) {
    pmId = await getProjectManagerEmployeeId(client);
  }
  if (!pmId) throw new Error("No project manager found");

  // 3. Create project
  const departmentId = await getDefaultDepartmentId(client);
  const projectBody: Record<string, unknown> = {
    name: projectName,
    projectManager: { id: pmId },
    department: { id: departmentId },
    startDate: today(),
    isInternal: false,
  };
  if (customerId) projectBody.customer = { id: customerId };
  if (budget > 0) projectBody.fixedprice = budget;

  let projectId: number;
  try {
    const result = await client.post<{ id: number }>("/project", projectBody);
    projectId = result.value.id;
    console.log(`[Handler] Created project: id=${projectId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("prosjektleder") || msg.includes("project manager") || msg.includes("rettighet")) {
      const fallbackPM = await getProjectManagerEmployeeId(client);
      if (fallbackPM && fallbackPM !== pmId) {
        projectBody.projectManager = { id: fallbackPM };
        const result = await client.post<{ id: number }>("/project", projectBody);
        projectId = result.value.id;
      } else {
        const knownExtended = ctx.isEmployeeExtended(pmId);
        await grantProjectManagerEntitlement(client, pmId, knownExtended);
        const result = await client.post<{ id: number }>("/project", projectBody);
        projectId = result.value.id;
      }
    } else {
      throw err;
    }
  }

  ctx.registerProject(projectName, projectId);

  // 4. Register hours (timesheet) if specified
  if (hours > 0) {
    try {
      // Get or create activity
      const activities = await client.list<{ id: number; name: string }>("/activity", {
        from: "0",
        count: "100",
      });
      let activityId = activities.values.find(
        (a) => a.name?.toLowerCase() === activityName.toLowerCase(),
      )?.id;

      if (!activityId && activities.values.length > 0) {
        activityId = activities.values[0].id;
      }

      if (!activityId) {
        try {
          const created = await client.post<{ id: number }>("/activity", { name: activityName });
          activityId = created.value.id;
        } catch {
          console.warn("[Handler] Could not create activity, skipping timesheet");
        }
      }

      if (activityId) {
        await client.post("/timesheet/entry", {
          employee: { id: pmId },
          project: { id: projectId },
          activity: { id: activityId },
          date: today(),
          hours,
          ...(hourlyRate > 0 ? { hourlyRate } : {}),
        });
        console.log(`[Handler] Registered ${hours} hours on project`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Handler] Timesheet entry failed: ${msg}`);
    }
  }

  // 5. Invoice the project
  await ensureBankAccountConfigured(client);
  const invoiceAmount = budget > 0
    ? Math.round(budget * (invoicePercentage / 100))
    : (hours > 0 && hourlyRate > 0 ? Math.round(hours * hourlyRate * (invoicePercentage / 100)) : 0);

  if (invoiceAmount > 0 && customerId) {
    try {
      const product = await findOrCreateProduct(client, projectName, invoiceAmount);
      const order = await client.post<{ id: number }>("/order", {
        customer: { id: customerId },
        orderDate: today(),
        deliveryDate: today(),
      });

      await client.post("/order/orderline", {
        order: { id: order.value.id },
        product: { id: product.id },
        count: 1,
        unitPriceExcludingVatCurrency: invoiceAmount,
      });

      const inv = await client.post<{ id: number }>("/invoice", {
        invoiceDate: today(),
        invoiceDueDate: today(),
        orders: [{ id: order.value.id }],
      });
      console.log(`[Handler] Created project invoice: id=${inv.value.id}, amount=${invoiceAmount}`);
      ctx.registerInvoice(customerName, inv.value.id);
    } catch (err) {
      console.warn(`[Handler] Project invoice failed: ${err}`);
    }
  } else {
    console.log("[Handler] No invoice amount calculated or no customer, skipping invoice step");
  }
}
