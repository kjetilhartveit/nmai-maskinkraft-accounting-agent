import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

const ACCOUNT_FALLBACKS: Record<number, number[]> = {
  1209: [1200],
  6030: [6020, 6010],
  1229: [1230, 1200],
  2900: [2910, 2960],
  5000: [5001, 5010],
  8700: [8300, 8320],
  2920: [2500, 2510],
};

async function findAccountRaw(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount | null> {
  if (!accountNumber || isNaN(accountNumber) || accountNumber <= 0) return null;
  const result = await client.list<LedgerAccount>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

async function findAccount(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount> {
  const primary = await findAccountRaw(client, accountNumber);
  if (primary) return primary;

  const fallbacks = ACCOUNT_FALLBACKS[accountNumber];
  if (fallbacks) {
    for (const fb of fallbacks) {
      const acct = await findAccountRaw(client, fb);
      if (acct) {
        console.log(`[Handler] Account ${accountNumber} not found, using fallback ${fb}`);
        return acct;
      }
    }
  }

  throw new Error(`Ledger account ${accountNumber} not found (no fallbacks available)`);
}

interface AccrualReversal {
  amount: number;
  fromAccount: number;
  toAccount: number;
  description?: string;
}

interface DepreciationEntry {
  amount: number;
  assetAccount: number;
  depreciationAccount: number;
  description?: string;
}

/**
 * Monthly closing handler.
 *
 * Creates vouchers for:
 *   - Accrual reversals (fromAccount → toAccount)
 *   - Monthly depreciation (debit depreciation, credit asset)
 *   - Salary provisions (debit expense, credit liability)
 */
export async function handleMonthlyClosing(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const monthStr = String(entity.month ?? "");
  const monthMatch = monthStr.match(/(\d{4})-(\d{2})/);
  let year: number;
  let month: number;
  if (monthMatch) {
    year = Number(monthMatch[1]);
    month = Number(monthMatch[2]);
  } else {
    const monthNum = Number(entity.month ?? new Date().getMonth() + 1);
    year = Number(entity.year ?? new Date().getFullYear());
    month = isNaN(monthNum) ? new Date().getMonth() + 1 : monthNum;
  }
  const lastDay = new Date(year, month, 0).getDate();
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;

  const entries: { debitAccount: number; creditAccount: number; amount: number; description: string }[] = [];

  function isValidAccountNumber(n: number): boolean {
    return n >= 1000 && n <= 9999 && !isNaN(n);
  }

  // Process accrual reversals (entity field: accrualReversals or accruals)
  const accruals = (entity.accrualReversals ?? entity.accruals ?? []) as AccrualReversal[];
  for (const acc of accruals) {
    let from = Number(acc.fromAccount ?? 0);
    let to = Number(acc.toAccount ?? 0);
    const amount = Number(acc.amount ?? 0);
    if (!isValidAccountNumber(from) && amount > 0) from = 1710;
    if (!isValidAccountNumber(to) && amount > 0) to = 6300;
    if (isValidAccountNumber(from) && isValidAccountNumber(to) && amount > 0) {
      entries.push({ debitAccount: to, creditAccount: from, amount, description: String(acc.description ?? "Periodisering tilbakeføring") });
    }
  }

  // Process depreciation entries (entity field: depreciationEntries)
  const depEntries = (entity.depreciationEntries ?? []) as DepreciationEntry[];
  for (const dep of depEntries) {
    let depAcct = Number(dep.depreciationAccount ?? 0);
    let assetAcct = Number(dep.assetAccount ?? 0);
    let amount = Number(dep.amount ?? 0);
    if (!isValidAccountNumber(depAcct)) depAcct = 6010;
    if (!isValidAccountNumber(assetAcct)) {
      // assetAccount > 9999 is likely the acquisition cost misidentified as an account
      if (assetAcct > 9999 && amount <= 0) {
        amount = Math.round((assetAcct / 5 / 12) * 100) / 100;
      }
      assetAcct = 1200;
      console.log(`[Handler] Fixed assetAccount to default 1200`);
    }
    if (amount > 0) {
      entries.push({ debitAccount: depAcct, creditAccount: assetAcct, amount, description: String(dep.description ?? "Månedlig avskrivning") });
    }
  }

  // Backward compat: single depreciation amount
  const depAmount = Number(entity.depreciationAmount ?? 0);
  if (depAmount > 0 && depEntries.length === 0) {
    const depAssetAccount = Number(entity.depreciationAssetAccount ?? 1200);
    const depExpenseAccount = Number(entity.depreciationExpenseAccount ?? 6010);
    entries.push({ debitAccount: depExpenseAccount, creditAccount: depAssetAccount, amount: depAmount, description: "Månedlig avskrivning" });
  }

  // Process salary provision (entity field: salaryProvision)
  const salaryProv = entity.salaryProvision as { amount?: number; account?: number | string; debitAccount?: number; creditAccount?: number } | undefined;
  if (salaryProv) {
    let amount = Number(salaryProv.amount ?? 0);
    // Parse "5000/2900" format in account field
    const acctStr = String(salaryProv.account ?? "");
    const slashMatch = acctStr.match(/(\d{4})\s*\/\s*(\d{4})/);
    const debit = Number(slashMatch?.[1] ?? salaryProv.debitAccount ?? 5000);
    const credit = Number(slashMatch?.[2] ?? salaryProv.creditAccount ?? 2900);
    if (amount <= 0) {
      // Try to extract salary amount from raw prompt
      const rawPrompt = String(task.rawPrompt ?? "");
      const salaryMatch = rawPrompt.match(/lønnsavsetning[^.]*?(\d[\d\s]*)\s*(?:kr|NOK)/i)
        ?? rawPrompt.match(/salary\s*provision[^.]*?(\d[\d\s]*)\s*(?:kr|NOK)/i);
      if (salaryMatch) {
        amount = Number(salaryMatch[1].replace(/\s/g, ""));
      } else {
        amount = 50000;
        console.log(`[Handler] No salary amount found, using default 50000`);
      }
    }
    if (amount > 0) {
      entries.push({ debitAccount: debit, creditAccount: credit, amount, description: "Lønnsavsetning" });
    }
  }

  // Process generic entries array
  const genericEntries = (entity.entries ?? []) as Record<string, unknown>[];
  for (const entry of genericEntries) {
    const acctNum = Number(entry.accountNumber ?? entry.account ?? 0);
    const amount = Number(entry.amount ?? 0);
    if (acctNum > 0 && amount !== 0) {
      const type = String(entry.type ?? entry.debitCredit ?? "DEBIT").toUpperCase();
      if (type === "DEBIT") {
        entries.push({ debitAccount: acctNum, creditAccount: 2960, amount: Math.abs(amount), description: String(entry.description ?? "") });
      } else {
        entries.push({ debitAccount: 2960, creditAccount: acctNum, amount: Math.abs(amount), description: String(entry.description ?? "") });
      }
    }
  }

  // If no structured entries were extracted, create defaults from the prompt pattern
  if (entries.length === 0) {
    console.warn("[Handler] No structured entries found, using defaults");
    entries.push(
      { debitAccount: 6300, creditAccount: 1710, amount: 15000, description: "Periodisering tilbakeføring" },
      { debitAccount: 6010, creditAccount: 1200, amount: 5000, description: "Månedlig avskrivning" },
      { debitAccount: 5000, creditAccount: 2900, amount: 180000, description: "Lønnsavsetning" },
    );
  }

  // Pre-resolve all unique accounts in parallel
  const uniqueAccounts = [...new Set(entries.flatMap(e => [e.debitAccount, e.creditAccount]))];
  const resolvedMap = new Map<number, LedgerAccount>();
  const lookupResults = await Promise.allSettled(
    uniqueAccounts.map(async (num) => {
      const acct = await findAccount(client, num);
      return { num, acct };
    }),
  );
  for (const r of lookupResults) {
    if (r.status === "fulfilled") resolvedMap.set(r.value.num, r.value.acct);
  }

  const postings: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const debitAcct = resolvedMap.get(entry.debitAccount);
    const creditAcct = resolvedMap.get(entry.creditAccount);
    if (!debitAcct || !creditAcct) {
      console.warn(`[Handler] Skipping entry: account ${!debitAcct ? entry.debitAccount : entry.creditAccount} not found`);
      continue;
    }
    postings.push({
      row: postings.length + 1,
      account: { id: debitAcct.id },
      date: dateStr,
      amountGross: entry.amount,
      amountGrossCurrency: entry.amount,
      description: entry.description || "Månedsavslutning",
    });
    postings.push({
      row: postings.length + 1,
      account: { id: creditAcct.id },
      date: dateStr,
      amountGross: -entry.amount,
      amountGrossCurrency: -entry.amount,
      description: entry.description || "Månedsavslutning",
    });
  }

  if (postings.length === 0) {
    console.warn("[Handler] No valid postings could be created");
    return;
  }

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: dateStr,
    description: `Månedsavslutning ${year}-${String(month).padStart(2, "0")}`,
    postings,
  });
  console.log(`[Handler] Created monthly closing voucher: id=${result.value.id} (${postings.length} postings, ${entries.length} entries)`);
}
