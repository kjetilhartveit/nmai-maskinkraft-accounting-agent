import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findCustomerByName,
  findEmployeeByName,
  findEmployeeByEmail,
  getDefaultDepartmentId,
  today,
  getProjectManagerEmployeeId,
  ensureBankAccountConfigured,
} from "../lib/tripletex-helpers.js";
import { grantProjectManagerEntitlement } from "./create-employee.js";

/**
 * Handler for "set a fixed price on a project and invoice X%".
 *
 * Competition pattern: create customer → create project → set fixed price →
 * invoice a percentage.
 *
 * Winning plans: get_customers -> get_current_employee -> create_project ->
 *   set_project_hourly_rate -> create_project_invoice
 */
export async function handleProjectFixedPrice(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const projectName = String(entity.projectName ?? entity.name ?? "");
  const customerName = String(entity.customerName ?? entity.customer ?? "");
  const orgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
  const fixedPrice = Number(entity.fixedPrice ?? entity.price ?? entity.amount ?? 0);
  const invoicePercentage = Number(entity.invoicePercentage ?? entity.percentage ?? 100);

  const pmFirstName = String(entity.projectManagerFirstName ?? "");
  const pmLastName = String(entity.projectManagerLastName ?? "");
  const pmEmail = String(entity.projectManagerEmail ?? "");

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

  // 3. Create project with fixed price settings
  const departmentId = await getDefaultDepartmentId(client);
  const projectBody: Record<string, unknown> = {
    name: projectName || "Prosjekt",
    projectManager: { id: pmId },
    department: { id: departmentId },
    startDate: today(),
    isInternal: false,
  };
  if (customerId) projectBody.customer = { id: customerId };
  if (fixedPrice > 0) {
    projectBody.fixedprice = fixedPrice;
  }

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

  // 4. Fixed price was already set in the POST body — skip PUT to avoid hourlyRates validation error

  // 5. Invoice the project (if percentage specified)
  if (fixedPrice > 0 && invoicePercentage > 0 && customerId) {
    await ensureBankAccountConfigured(client);

    const invoiceAmount = Math.round(fixedPrice * (invoicePercentage / 100));

    // Create order-based invoice (direct project→invoice is not supported)
    const { findOrCreateProduct } = await import("../lib/tripletex-helpers.js");
    const product = await findOrCreateProduct(client, projectName || "Prosjekttjeneste", invoiceAmount);

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
  }
}
