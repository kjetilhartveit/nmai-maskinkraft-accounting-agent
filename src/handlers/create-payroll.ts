import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findEmployeeByEmail,
  findEmployeeByName,
  getDefaultDepartmentId,
  today,
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

interface LedgerAccount {
  id: number;
  number: number;
}

const accountCache = new Map<number, LedgerAccount>();

async function findAccount(client: TripletexClient, accountNumber: number): Promise<LedgerAccount> {
  const cached = accountCache.get(accountNumber);
  if (cached) return cached;
  const result = await client.list<LedgerAccount>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  const account = result.values[0];
  if (!account) throw new Error(`Ledger account ${accountNumber} not found`);
  accountCache.set(accountNumber, account);
  return account;
}

export function resetPayrollCache(): void {
  accountCache.clear();
}

async function createPayrollVoucher(
  client: TripletexClient,
  employeeId: number,
  baseSalary: number,
  bonus: number,
  firstName: string,
  lastName: string,
): Promise<void> {
  const [salaryAccount, taxExpenseAccount, taxPayableAccount, bankAccount] = await Promise.all([
    findAccount(client, 5000),
    findAccount(client, 5400),
    findAccount(client, 2780),
    findAccount(client, 1920),
  ]);

  const totalSalary = baseSalary + bonus;
  const employerTax = Math.round(totalSalary * 0.141);

  const voucherDate = today();
  const empName = firstName && lastName ? `${firstName} ${lastName}` : "ansatt";

  const postings: Record<string, unknown>[] = [];
  let row = 1;

  if (baseSalary > 0) {
    postings.push({
      row: row++,
      account: { id: salaryAccount.id },
      date: voucherDate,
      amountGross: baseSalary,
      amountGrossCurrency: baseSalary,
      description: `Lønn ${empName}`,
      employee: { id: employeeId },
    });
  }

  if (bonus > 0) {
    postings.push({
      row: row++,
      account: { id: salaryAccount.id },
      date: voucherDate,
      amountGross: bonus,
      amountGrossCurrency: bonus,
      description: `Bonus ${empName}`,
      employee: { id: employeeId },
    });
  }

  // Employer tax expense (debit 5400)
  postings.push({
    row: row++,
    account: { id: taxExpenseAccount.id },
    date: voucherDate,
    amountGross: employerTax,
    amountGrossCurrency: employerTax,
    description: `Arbeidsgiveravgift ${empName}`,
    employee: { id: employeeId },
  });

  // Employer tax payable (credit 2780)
  postings.push({
    row: row++,
    account: { id: taxPayableAccount.id },
    date: voucherDate,
    amountGross: -employerTax,
    amountGrossCurrency: -employerTax,
    description: `Skyldig AGA ${empName}`,
    employee: { id: employeeId },
  });

  // Bank credit for gross salary (net pay to employee)
  postings.push({
    row: row++,
    account: { id: bankAccount.id },
    date: voucherDate,
    amountGross: -totalSalary,
    amountGrossCurrency: -totalSalary,
    description: `Utbetaling lønn ${empName}`,
    employee: { id: employeeId },
  });

  const body = {
    date: voucherDate,
    description: `Lønn ${empName}`,
    postings,
  };

  const result = await client.post<{ id: number }>("/ledger/voucher", body);
  console.log(
    `[Handler] Created payroll voucher: id=${result.value.id} (salary=${totalSalary}, employerTax=${employerTax}, bankPay=${totalSalary})`,
  );
}
