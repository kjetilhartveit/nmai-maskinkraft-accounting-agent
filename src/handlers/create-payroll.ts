import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findEmployeeByEmail,
  findEmployeeByName,
  getDefaultDepartmentId,
  today,
  getMultipleAccountsByNumber,
} from "../lib/tripletex-helpers.js";

/**
 * Deterministic payroll handler.
 *
 * Strategy: find/create employee → create voucher with salary + tax postings.
 * Uses voucher approach directly — salary BETA endpoints are unreliable in sandbox.
 */
export async function handleCreatePayroll(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const firstName = String(entity.employeeFirstName ?? entity.firstName ?? "");
  const lastName = String(entity.employeeLastName ?? entity.lastName ?? "");
  const email = String(entity.employeeEmail ?? entity.email ?? "");
  const baseSalary = Number(entity.baseSalary ?? entity.salary ?? 0);
  const bonus = Number(entity.bonus ?? 0);

  // 1. Find or create employee
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
    employeeId = ctx.getEmployeeId(`${firstName} ${lastName}`) ?? null;
    if (!employeeId) {
      const emp = await findEmployeeByName(client, firstName, lastName);
      if (emp) {
        employeeId = emp.id;
        ctx.registerEmployee(`${firstName} ${lastName}`, emp.id);
      }
    }
  }

  if (!employeeId) {
    const departmentId = await getDefaultDepartmentId(client);
    const body: Record<string, unknown> = {
      firstName: firstName || "Ansatt",
      lastName: lastName || "Ukjent",
      department: { id: departmentId },
    };
    if (email) {
      body.email = email;
      body.userType = "EXTENDED";
    }
    const result = await client.post<{ id: number }>("/employee", body);
    employeeId = result.value.id;
    console.log(`[Handler] Created employee for payroll: id=${employeeId}`);
    if (email) ctx.registerEmployee(email, employeeId);
    if (firstName && lastName) ctx.registerEmployee(`${firstName} ${lastName}`, employeeId);
  }

  // 2. Create payroll voucher (reliable approach — salary BETA endpoints are unstable in sandbox)
  await createPayrollVoucher(client, employeeId, baseSalary, bonus, firstName, lastName);
}

export function resetPayrollCache(): void {
  // Bulk account cache is now shared in tripletex-helpers
}

async function createPayrollVoucher(
  client: TripletexClient,
  employeeId: number,
  baseSalary: number,
  bonus: number,
  firstName: string,
  lastName: string,
): Promise<void> {
  const accounts = await getMultipleAccountsByNumber(client, [5000, 2780, 1920]);
  const salaryAccount = accounts.get(5000);
  const taxAccount = accounts.get(2780);
  const bankAccount = accounts.get(1920);
  if (!salaryAccount || !taxAccount || !bankAccount) throw new Error("Required accounts not found");

  const totalSalary = baseSalary + bonus;
  const employerTax = Math.round(totalSalary * 0.141);
  const totalCredit = totalSalary + employerTax;

  const voucherDate = today();
  const empName = firstName && lastName ? `${firstName} ${lastName}` : "ansatt";

  const body = {
    date: voucherDate,
    description: `Lønn ${empName}`,
    postings: [
      {
        row: 1,
        account: { id: salaryAccount.id },
        date: voucherDate,
        amountGross: totalSalary,
        amountGrossCurrency: totalSalary,
        description: "Lønn",
      },
      {
        row: 2,
        account: { id: taxAccount.id },
        date: voucherDate,
        amountGross: employerTax,
        amountGrossCurrency: employerTax,
        description: "Arbeidsgiveravgift",
      },
      {
        row: 3,
        account: { id: bankAccount.id },
        date: voucherDate,
        amountGross: -totalCredit,
        amountGrossCurrency: -totalCredit,
        description: "Utbetaling",
      },
    ],
  };

  const result = await client.post<{ id: number }>("/ledger/voucher", body);
  console.log(
    `[Handler] Created payroll voucher: id=${result.value.id} (salary=${totalSalary}, tax=${employerTax}, total=${totalCredit})`,
  );
}
