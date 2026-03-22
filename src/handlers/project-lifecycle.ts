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
  daysFromNow,
  ensureBankAccountConfigured,
  findOrCreateProduct,
} from "../lib/tripletex-helpers.js";
import { grantProjectManagerEntitlement } from "./create-employee.js";

interface EmployeeEntry {
  firstName?: string;
  lastName?: string;
  email?: string;
  hours: number;
  hourlyRate?: number;
}

interface SupplierCost {
  supplierName?: string;
  amount: number;
  description?: string;
}

/**
 * Full project lifecycle handler.
 *
 * Creates project → registers hours for employees → registers supplier costs →
 * creates invoice to customer.
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
  const budget = Number(entity.budgetAmount ?? entity.budget ?? 0);
  const invoicePercentage = Number(entity.invoicePercentage ?? 100);

  // Parse employee entries from entity extraction
  const employeeEntries: EmployeeEntry[] = [];
  const rawEmployees = (entity.employees ?? []) as Record<string, unknown>[];
  for (const emp of rawEmployees) {
    employeeEntries.push({
      firstName: String(emp.firstName ?? ""),
      lastName: String(emp.lastName ?? ""),
      email: emp.email ? String(emp.email) : undefined,
      hours: Number(emp.hours ?? 0),
      hourlyRate: emp.hourlyRate ? Number(emp.hourlyRate) : undefined,
    });
  }

  // Parse supplier cost
  const supplierCostRaw = entity.supplierCost as SupplierCost | undefined;
  const supplierCost: SupplierCost | null = supplierCostRaw?.amount
    ? { supplierName: String(supplierCostRaw.supplierName ?? ""), amount: Number(supplierCostRaw.amount), description: String(supplierCostRaw.description ?? "") }
    : null;

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

  // 2. Resolve project manager (first employee in sandbox)
  const pmId = await getProjectManagerEmployeeId(client);
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
      const knownExtended = ctx.isEmployeeExtended(pmId);
      await grantProjectManagerEntitlement(client, pmId, knownExtended);
      const result = await client.post<{ id: number }>("/project", projectBody);
      projectId = result.value.id;
    } else {
      throw err;
    }
  }
  ctx.registerProject(projectName, projectId);

  // 4. Create project activity with unique name
  let defaultActivityId: number | null = null;
  try {
    const actResult = await client.post<{ id: number }>("/activity", {
      name: `${projectName} ${Date.now()}`,
      activityType: "PROJECT_GENERAL_ACTIVITY",
    });
    defaultActivityId = actResult.value.id;
    console.log(`[Handler] Created activity: id=${defaultActivityId}`);
  } catch {
    console.log("[Handler] Could not create activity, proceeding without");
  }

  // 5. Register hours for each employee
  let totalHoursRevenue = 0;
  for (let i = 0; i < employeeEntries.length; i++) {
    const emp = employeeEntries[i];
    if (emp.hours <= 0) continue;

    let empId: number | null = null;
    if (emp.firstName && emp.lastName) {
      const found = await findEmployeeByName(client, emp.firstName, emp.lastName);
      if (found) empId = found.id;
    }
    if (!empId && emp.email) {
      const found = await findEmployeeByEmail(client, emp.email);
      if (found) empId = found.id;
    }
    if (!empId) empId = pmId;

    const baseOffset = Math.floor(Math.random() * 30) + 30;
    const entryDate = daysFromNow(baseOffset + i);
    const timesheetBody: Record<string, unknown> = {
      employee: { id: empId },
      project: { id: projectId },
      date: entryDate,
      hours: emp.hours,
    };
    if (defaultActivityId) timesheetBody.activity = { id: defaultActivityId };

    try {
      await client.post("/timesheet/entry", timesheetBody);
      console.log(`[Handler] Registered ${emp.hours}h for ${emp.firstName} ${emp.lastName}`);
      totalHoursRevenue += emp.hours * (emp.hourlyRate ?? 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409") || msg.includes("allerede")) {
        timesheetBody.date = daysFromNow(baseOffset + i + 15);
        try {
          await client.post("/timesheet/entry", timesheetBody);
          console.log(`[Handler] Registered ${emp.hours}h on alternate date`);
          totalHoursRevenue += emp.hours * (emp.hourlyRate ?? 0);
        } catch {
          console.warn(`[Handler] Timesheet retry also failed`);
        }
      } else {
        console.warn(`[Handler] Timesheet entry failed: ${msg}`);
      }
    }
  }

  // 6. Register supplier cost as voucher
  if (supplierCost && supplierCost.amount > 0) {
    try {
      const [expenseAcct, bankAcct] = await Promise.all([
        findAccountByNumber(client, 6300),
        findAccountByNumber(client, 1920),
      ]);
      await client.post("/ledger/voucher", {
        date: today(),
        description: supplierCost.description || `Leverandørkostnad: ${supplierCost.supplierName}`,
        postings: [
          { row: 1, account: { id: expenseAcct.id }, date: today(), amountGross: supplierCost.amount, amountGrossCurrency: supplierCost.amount, description: supplierCost.description || "Leverandørkostnad" },
          { row: 2, account: { id: bankAcct.id }, date: today(), amountGross: -supplierCost.amount, amountGrossCurrency: -supplierCost.amount, description: "Betaling" },
        ],
      });
      console.log(`[Handler] Registered supplier cost: ${supplierCost.amount} NOK`);
    } catch (err) {
      console.warn(`[Handler] Supplier voucher failed: ${err}`);
    }
  }

  // 7. Invoice the project
  await ensureBankAccountConfigured(client);
  const invoiceAmount = budget > 0
    ? Math.round(budget * (invoicePercentage / 100))
    : (totalHoursRevenue > 0 ? Math.round(totalHoursRevenue * (invoicePercentage / 100)) : 0);

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
  }
}

async function findAccountByNumber(
  client: TripletexClient,
  accountNumber: number,
): Promise<{ id: number; number: number }> {
  const result = await client.list<{ id: number; number: number }>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  const account = result.values[0];
  if (!account) throw new Error(`Ledger account ${accountNumber} not found`);
  return account;
}
