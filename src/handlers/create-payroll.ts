import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findEmployeeByEmail,
  findEmployeeByName,
  getDefaultDepartmentId,
  today,
} from "../lib/tripletex-helpers.js";

interface SalaryType {
  id: number;
  number: string;
  name: string;
  description?: string;
}

/**
 * Deterministic payroll handler.
 *
 * Competition checks:
 *   1. Employee found/created
 *   2. Employment record exists
 *   3. Base salary recorded
 *   4. Bonus recorded
 *
 * Strategy: employee → employment → salary types → salary transaction
 * Fallback: if salary API returns 403, fall back to manual voucher approach.
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

  // 2. Create employment record (required for salary processing)
  const startDate = today().slice(0, 8) + "01";
  try {
    await client.post("/employee/employment", {
      employee: { id: employeeId },
      startDate,
      employmentType: "ORDINARY",
      percentageOfFullTimeEquivalent: 100,
    });
    console.log(`[Handler] Created employment for employee ${employeeId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403")) {
      console.log("[Handler] Employment endpoint returned 403 (BETA), continuing with voucher fallback");
      await createPayrollVoucher(client, employeeId, baseSalary, bonus, firstName, lastName);
      return;
    }
    if (msg.includes("already") || msg.includes("allerede") || msg.includes("overlapping")) {
      console.log("[Handler] Employment already exists, continuing");
    } else {
      console.warn(`[Handler] Employment creation failed: ${msg}, continuing anyway`);
    }
  }

  // 3. Get salary types to find base salary and bonus type IDs
  let salaryTypes: SalaryType[] = [];
  try {
    const result = await client.list<SalaryType>("/salary/type", {
      from: "0",
      count: "100",
    });
    salaryTypes = result.values;
    console.log(`[Handler] Found ${salaryTypes.length} salary types`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403")) {
      console.log("[Handler] Salary type endpoint returned 403, falling back to voucher");
      await createPayrollVoucher(client, employeeId, baseSalary, bonus, firstName, lastName);
      return;
    }
    throw err;
  }

  // Find base salary type (typically "Fastlønn" or number "1") and bonus type
  const baseSalaryType = salaryTypes.find(
    (t) => t.number === "1" || t.name?.toLowerCase().includes("fastlønn") || t.name?.toLowerCase().includes("månedslønn"),
  ) ?? salaryTypes[0];

  const bonusType = salaryTypes.find(
    (t) => t.name?.toLowerCase().includes("bonus") || t.name?.toLowerCase().includes("tillegg") || t.number === "30",
  );

  // 4. Create salary transaction
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const specifications: Record<string, unknown>[] = [];

  if (baseSalary > 0 && baseSalaryType) {
    specifications.push({
      salaryType: { id: baseSalaryType.id },
      rate: baseSalary,
      count: 1,
      amount: baseSalary,
      description: "Grunnlønn",
    });
  }

  if (bonus > 0) {
    const bt = bonusType ?? baseSalaryType;
    if (bt) {
      specifications.push({
        salaryType: { id: bt.id },
        rate: bonus,
        count: 1,
        amount: bonus,
        description: "Bonus",
      });
    }
  }

  try {
    const txBody = {
      employee: { id: employeeId },
      date: today(),
      year,
      month,
      specifications,
    };

    const result = await client.post<{ id: number }>("/salary/transaction", txBody);
    console.log(`[Handler] Created salary transaction: id=${result.value.id} (base=${baseSalary}, bonus=${bonus})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403")) {
      console.log("[Handler] Salary transaction returned 403, falling back to voucher");
      await createPayrollVoucher(client, employeeId, baseSalary, bonus, firstName, lastName);
      return;
    }
    console.warn(`[Handler] Salary transaction failed: ${msg}, trying voucher fallback`);
    await createPayrollVoucher(client, employeeId, baseSalary, bonus, firstName, lastName);
  }
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
  const [salaryAccount, taxAccount, bankAccount] = await Promise.all([
    findAccount(client, 5000),
    findAccount(client, 2780),
    findAccount(client, 1920),
  ]);

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
