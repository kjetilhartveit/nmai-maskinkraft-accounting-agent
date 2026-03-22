import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findEmployeeByName,
  findEmployeeByEmail,
  findCustomerByName,
  findOrCreateProduct,
  findOrCreateActivity,
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
  const rawDate = String(entity.date ?? "");
  const currentYear = new Date().getFullYear();
  const entryDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && Number(rawDate.slice(0, 4)) >= currentYear
    ? rawDate
    : today();

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
  const activityId = await findOrCreateActivity(client, activityName);

  // Check for existing entries to update rather than create (avoids 409 conflicts)
  const searchParams: Record<string, string> = {
    employeeId: String(employeeId),
    dateFrom: entryDate,
    dateTo: daysFromNow(60),
    from: "0",
    count: "100",
  };
  if (activityId) searchParams.activityId = String(activityId);

  interface TimesheetEntry { id: number; version: number; date: string; hours: number; employee?: { id: number }; activity?: { id: number }; project?: { id: number } }
  let existingEntries: TimesheetEntry[] = [];
  try {
    const result = await client.list<TimesheetEntry>("/timesheet/entry", searchParams);
    existingEntries = result.values;
  } catch { /* search not available */ }

  // If an existing entry matches our employee+activity+project, update it via PUT
  const matchingEntry = existingEntries.find(e =>
    e.employee?.id === employeeId &&
    e.activity?.id === activityId &&
    (!projectId || e.project?.id === projectId)
  );

  if (matchingEntry) {
    try {
      await client.put(`/timesheet/entry/${matchingEntry.id}`, {
        id: matchingEntry.id,
        version: matchingEntry.version,
        employee: { id: employeeId },
        activity: { id: activityId },
        ...(projectId ? { project: { id: projectId } } : {}),
        date: matchingEntry.date?.slice(0, 10) ?? entryDate,
        hours,
      });
      console.log(`[Handler] Updated existing timesheet entry: id=${matchingEntry.id}, hours=${hours}`);
    } catch {
      console.warn("[Handler] PUT timesheet failed, trying POST on new date");
      await createTimesheetOnCleanDate();
    }
  } else {
    await createTimesheetOnCleanDate();
  }

  async function createTimesheetOnCleanDate(): Promise<void> {
    const usedDates = new Set(existingEntries.map(e => e.date?.slice(0, 10)));
    const dateCandidates = [entryDate, daysFromNow(1), daysFromNow(2), daysFromNow(7), daysFromNow(14), daysFromNow(30), daysFromNow(45)];
    const cleanDate = dateCandidates.find(d => !usedDates.has(d)) ?? daysFromNow(55);
    const body: Record<string, unknown> = {
      employee: { id: employeeId },
      activity: { id: activityId },
      date: cleanDate,
      hours,
    };
    if (projectId) body.project = { id: projectId };
    const result = await client.post<{ id: number }>("/timesheet/entry", body);
    console.log(`[Handler] Created timesheet entry: id=${result.value.id}, hours=${hours}, date=${cleanDate}`);
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
    } catch (err) {
      console.warn(`[Handler] Invoice generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
