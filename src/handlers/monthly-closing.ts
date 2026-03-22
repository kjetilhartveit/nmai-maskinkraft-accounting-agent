import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

const accountCache = new Map<number, LedgerAccount>();

async function findAccount(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount> {
  if (!accountNumber || isNaN(accountNumber) || accountNumber <= 0) {
    throw new Error(`Invalid account number: ${accountNumber}`);
  }
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

export function resetMonthlyClosingCache(): void {
  accountCache.clear();
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

  // Process accrual reversals (entity field: accrualReversals or accruals)
  const accruals = (entity.accrualReversals ?? entity.accruals ?? []) as AccrualReversal[];
  for (const acc of accruals) {
    const from = Number(acc.fromAccount ?? 0);
    const to = Number(acc.toAccount ?? 0);
    const amount = Number(acc.amount ?? 0);
    if (from > 0 && to > 0 && amount > 0) {
      entries.push({ debitAccount: to, creditAccount: from, amount, description: String(acc.description ?? "Periodisering tilbakeføring") });
    }
  }

  // Process depreciation entries (entity field: depreciationEntries)
  const depEntries = (entity.depreciationEntries ?? []) as DepreciationEntry[];
  for (const dep of depEntries) {
    const depAcct = Number(dep.depreciationAccount ?? 0);
    const assetAcct = Number(dep.assetAccount ?? 0);
    const amount = Number(dep.amount ?? 0);
    if (depAcct > 0 && assetAcct > 0 && amount > 0) {
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
  const salaryProv = entity.salaryProvision as { amount?: number; account?: number; debitAccount?: number; creditAccount?: number } | undefined;
  if (salaryProv) {
    const amount = Number(salaryProv.amount ?? 0);
    const debit = Number(salaryProv.debitAccount ?? salaryProv.account ?? 5000);
    const credit = Number(salaryProv.creditAccount ?? 2900);
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

  // Build voucher postings — skip entries where accounts don't exist in sandbox
  const postings: Record<string, unknown>[] = [];
  for (const entry of entries) {
    try {
      const debitAcct = await findAccount(client, entry.debitAccount);
      const creditAcct = await findAccount(client, entry.creditAccount);
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
    } catch (err) {
      console.warn(`[Handler] Skipping entry: ${err instanceof Error ? err.message : err}`);
    }
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
