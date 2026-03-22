import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findCustomerByName,
  findEmployeeByName,
  findEmployeeByEmail,
  getDefaultDepartmentId,
  getProjectManagerEmployeeId,
  findOrCreateActivity,
  today,
  daysFromNow,
  ensureBankAccountConfigured,
  findOrCreateProduct,
  postLedgerVoucherWithSupplierFallback,
} from "../lib/tripletex-helpers.js";
import { buildEmployeeBody, createEmployment, grantProjectManagerEntitlement } from "./create-employee.js";

interface EmployeeEntry {
  firstName?: string;
  lastName?: string;
  email?: string;
  hours: number;
  hourlyRate?: number;
  role?: string;
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
      role: emp.role ? String(emp.role) : undefined,
    });
  }

  // Parse supplier cost
  const supplierCostRaw = entity.supplierCost as Record<string, unknown> | undefined;
  const supplierCost = supplierCostRaw?.amount
    ? {
        supplierName: String(supplierCostRaw.supplierName ?? ""),
        organizationNumber: supplierCostRaw.organizationNumber ? String(supplierCostRaw.organizationNumber) : undefined,
        amount: Number(supplierCostRaw.amount),
        description: String(supplierCostRaw.description ?? ""),
      }
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

  // 4. Find or create project activity (scoped name avoids global "name in use" on shared titles)
  const defaultActivityId = await findOrCreateActivity(client, `${projectName} (${projectId})`);

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
    if (!empId && emp.firstName && emp.lastName) {
      try {
        const email = emp.email || `${emp.firstName.toLowerCase()}.${emp.lastName.toLowerCase()}@example.com`;
        const empEntity: Record<string, unknown> = {
          firstName: emp.firstName,
          lastName: emp.lastName,
          email,
        };
        let body = buildEmployeeBody(empEntity, departmentId);
        if (!empEntity.email) {
          body = { ...body, dateOfBirth: "1990-01-01" };
        }
        let created: { value: { id: number } };
        try {
          created = await client.post<{ id: number }>("/employee", body);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("422")) {
            const minimal: Record<string, unknown> = {
              firstName: emp.firstName,
              lastName: emp.lastName,
              department: { id: departmentId },
            };
            if (email) {
              minimal.email = email;
              minimal.userType = "EXTENDED";
            }
            created = await client.post<{ id: number }>("/employee", minimal);
          } else {
            throw err;
          }
        }
        empId = created.value.id;
        await createEmployment(client, empId, today());
        console.log(`[Handler] Created employee: ${emp.firstName} ${emp.lastName} (id=${empId})`);
      } catch (err) {
        console.warn(`[Handler] Failed to create employee ${emp.firstName}: ${err}`);
      }
    }
    if (!empId) empId = pmId;

    const dateCandidates = [today(), daysFromNow(1 + i), daysFromNow(5 + i), daysFromNow(10 + i)];
    const timesheetBody: Record<string, unknown> = {
      employee: { id: empId },
      project: { id: projectId },
      activity: { id: defaultActivityId },
      hours: emp.hours,
    };

    let timesheetCreated = false;
    for (const date of dateCandidates) {
      timesheetBody.date = date;
      try {
        await client.post("/timesheet/entry", timesheetBody);
        console.log(`[Handler] Registered ${emp.hours}h for ${emp.firstName} ${emp.lastName} on ${date}`);
        totalHoursRevenue += emp.hours * (emp.hourlyRate ?? 0);
        timesheetCreated = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("409") || msg.includes("allerede")) continue;
        console.warn(`[Handler] Timesheet entry failed: ${msg}`);
        break;
      }
    }
    if (!timesheetCreated) {
      console.warn(`[Handler] Could not create timesheet for ${emp.firstName}`);
    }
  }

  // 6. Register supplier cost as voucher (debit expense, credit accounts payable with supplier)
  if (supplierCost && supplierCost.amount > 0) {
    try {
      let supplierId: number | null = null;
      if (supplierCost.supplierName) {
        const suppliers = await client.list<{ id: number; name: string }>("/supplier", {
          name: supplierCost.supplierName,
          from: "0",
          count: "5",
        });
        if (suppliers.values.length > 0) {
          supplierId = suppliers.values[0].id;
        } else {
          const supplierBody: Record<string, unknown> = {
            name: supplierCost.supplierName,
            isSupplier: true,
          };
          if (supplierCost.organizationNumber) supplierBody.organizationNumber = supplierCost.organizationNumber;
          const created = await client.post<{ id: number }>("/supplier", supplierBody);
          supplierId = created.value.id;
        }
      }

      const [expenseAcct, apAcct] = await Promise.all([
        findAccountByNumber(client, 6300),
        findAccountByNumber(client, 2400),
      ]);
      const creditPosting: Record<string, unknown> = {
        row: 2,
        account: { id: apAcct.id },
        date: today(),
        amountGross: -supplierCost.amount,
        amountGrossCurrency: -supplierCost.amount,
        description: supplierCost.supplierName || "Leverandørgjeld",
      };
      if (supplierId) creditPosting.supplier = { id: supplierId };

      await postLedgerVoucherWithSupplierFallback(client, {
        date: today(),
        description: supplierCost.description || `Leverandørkostnad: ${supplierCost.supplierName}`,
        postings: [
          { row: 1, account: { id: expenseAcct.id }, date: today(), amountGross: supplierCost.amount, amountGrossCurrency: supplierCost.amount, description: supplierCost.description || "Leverandørkostnad" },
          creditPosting,
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
