import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findEmployeeByName,
  findEmployeeByEmail,
  findCustomerByName,
  findOrCreateProduct,
  today,
  daysFromNow,
  getDefaultDepartmentId,
  getProjectManagerEmployeeId,
  ensureBankAccountConfigured,
} from "../lib/tripletex-helpers.js";

interface Project {
  id: number;
  name: string;
}

export async function handleCreateTimesheet(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const firstName = String(entity.employeeFirstName ?? entity.firstName ?? "");
  const lastName = String(entity.employeeLastName ?? entity.lastName ?? "");
  const email = String(entity.employeeEmail ?? entity.email ?? "");
  const hours = Number(entity.hours ?? 0);
  const activityName = String(entity.activityName ?? entity.activity ?? "Arbeid");
  const projectName = String(entity.projectName ?? entity.project ?? "");
  const customerName = String(entity.customerName ?? entity.customer ?? "");
  const orgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
  const hourlyRate = Number(entity.hourlyRate ?? entity.rate ?? 0);
  const entryDate = String(entity.date ?? today());

  let employeeId: number | null = null;

  if (email) {
    employeeId = ctx.getEmployeeId(email) ?? null;
    if (!employeeId) {
      const emp = await findEmployeeByEmail(client, email);
      if (emp) {
        employeeId = emp.id;
        ctx.registerEmployee(email, emp.id);
      }
    }
  }
  if (!employeeId && firstName && lastName) {
    const emp = await findEmployeeByName(client, firstName, lastName);
    if (emp) employeeId = emp.id;
  }
  if (!employeeId) {
    const fallback = await client.list<{ id: number }>("/employee", { from: "0", count: "1" });
    if (fallback.values.length > 0) employeeId = fallback.values[0].id;
    else throw new Error("No employee found for timesheet entry");
  }

  const pmId = employeeId ?? (await getProjectManagerEmployeeId(client));
  const departmentId = await getDefaultDepartmentId(client);

  // Find or create customer for invoicing
  let customerId: number | null = null;
  if (customerName) {
    const ctxCustId = ctx.getCustomerId(customerName);
    if (ctxCustId) {
      customerId = ctxCustId;
    } else {
      const cust = await findCustomerByName(client, customerName);
      if (cust) {
        customerId = cust.id;
      } else {
        const custBody: Record<string, unknown> = { name: customerName, isCustomer: true };
        if (orgNumber) custBody.organizationNumber = orgNumber;
        const created = await client.post<{ id: number }>("/customer", custBody);
        customerId = created.value.id;
        console.log(`[Handler] Created customer: ${customerName} id=${customerId}`);
      }
      if (customerId) ctx.registerCustomer(customerName, customerId);
    }
  }

  // Find or create project
  let projectId: number | null = null;
  if (projectName) {
    try {
      const projects = await client.list<Project>("/project", {
        name: projectName,
        from: "0",
        count: "5",
      });
      if (projects.values.length > 0) {
        projectId = projects.values[0].id;
      }
    } catch {
      // project search failed
    }

    if (!projectId) {
      const projectBody: Record<string, unknown> = {
        name: projectName,
        projectManager: { id: pmId },
        department: { id: departmentId },
        startDate: today(),
        isInternal: false,
      };
      if (customerId) projectBody.customer = { id: customerId };
      const project = await client.post<{ id: number }>("/project", projectBody);
      projectId = project.value.id;
      console.log(`[Handler] Created project: id=${projectId}`);
      ctx.registerProject(projectName, projectId);
    }
  }

  // Find or create activity
  let activityId: number | null = null;
  try {
    const existing = await client.list<{ id: number; name: string }>("/activity", {
      name: activityName,
      from: "0",
      count: "5",
    });
    const match = existing.values.find(
      (a) => a.name?.toLowerCase() === activityName.toLowerCase()
    );
    if (match) {
      activityId = match.id;
      console.log(`[Handler] Found existing activity: "${activityName}" id=${activityId}`);
    }
  } catch {
    // activity search not available, will create
  }

  if (!activityId) {
    try {
      const actResult = await client.post<{ id: number }>("/activity", {
        name: activityName.slice(0, 255),
        activityType: "PROJECT_GENERAL_ACTIVITY",
      });
      activityId = actResult.value.id;
      console.log(`[Handler] Created activity: "${activityName}" id=${activityId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("422") || msg.includes("i bruk") || msg.includes("in use")) {
        // Name already taken - search again
        try {
          const retry = await client.list<{ id: number; name: string }>("/activity", {
            from: "0",
            count: "100",
          });
          const match = retry.values.find(
            (a) => a.name?.toLowerCase() === activityName.toLowerCase()
          );
          if (match) activityId = match.id;
        } catch { /* ignore */ }
      }
      if (!activityId) console.warn(`[Handler] Could not create or find activity: ${msg}`);
    }
  }

  // Create timesheet entry with actual date from prompt
  const timesheetBody: Record<string, unknown> = {
    employee: { id: employeeId },
    date: entryDate,
    hours,
  };
  if (projectId) timesheetBody.project = { id: projectId };
  if (activityId) timesheetBody.activity = { id: activityId };

  try {
    const result = await client.post<{ id: number }>("/timesheet/entry", timesheetBody);
    console.log(`[Handler] Created timesheet entry: id=${result.value.id}, hours=${hours}, date=${entryDate}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("409") || msg.includes("allerede") || msg.includes("already")) {
      timesheetBody.date = daysFromNow(1);
      const result = await client.post<{ id: number }>("/timesheet/entry", timesheetBody);
      console.log(`[Handler] Created timesheet entry on retry date: id=${result.value.id}`);
    } else {
      throw err;
    }
  }

  // Generate a project invoice to the customer based on logged hours
  if (customerId && hours > 0) {
    try {
      await ensureBankAccountConfigured(client);

      const invoiceAmount = hourlyRate > 0 ? hours * hourlyRate : hours * 1000;
      const productName = activityName || projectName || "Konsulenttjenester";
      const product = await findOrCreateProduct(client, productName, invoiceAmount);

      const orderResult = await client.post<{ id: number }>("/order", {
        customer: { id: customerId },
        orderDate: today(),
        deliveryDate: daysFromNow(14),
      });
      const orderId = orderResult.value.id;

      await client.post("/order/orderline", {
        order: { id: orderId },
        product: { id: product.id },
        count: 1,
        unitPriceExcludingVatCurrency: invoiceAmount,
      });

      const invoiceResult = await client.post<{ id: number; amount: number }>("/invoice", {
        invoiceDate: today(),
        invoiceDueDate: daysFromNow(14),
        orders: [{ id: orderId }],
      });
      const invoiceId = invoiceResult.value.id;
      console.log(`[Handler] Created project invoice: id=${invoiceId}, amount=${invoiceAmount}`);
      ctx.registerInvoice(customerName, invoiceId);

      try {
        await client.put(`/invoice/${invoiceId}/:send?sendType=EMAIL&overrideEmailAddress=faktura@example.no`, {});
        console.log(`[Handler] Sent invoice ${invoiceId}`);
      } catch {
        console.warn(`[Handler] Could not send invoice ${invoiceId}`);
      }
    } catch (err) {
      console.warn(`[Handler] Invoice generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
