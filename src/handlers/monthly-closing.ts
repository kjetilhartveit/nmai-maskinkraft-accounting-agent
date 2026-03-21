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

/**
 * Monthly closing handler.
 *
 * Creates vouchers for monthly accruals, depreciation, and prepaid expenses.
 * Standard entries:
 *   - Accruals: debit expense, credit accrued liability (2960)
 *   - Monthly depreciation: debit 6010, credit asset account
 *   - Prepaid expenses: debit 1700 (forskuddsbetalt), credit expense
 */
export async function handleMonthlyClosing(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const month = Number(entity.month ?? new Date().getMonth() + 1);
  const year = Number(entity.year ?? new Date().getFullYear());
  const lastDay = new Date(year, month, 0).getDate();
  const dateStr = String(entity.date ?? `${year}-${String(month).padStart(2, "0")}-${lastDay}`);

  // Collect entries
  const entries: { accountNumber: number; amount: number; type: string; description: string }[] = [];

  // From entries array in entity
  const entityEntries = Array.isArray(entity.entries) ? entity.entries as Record<string, unknown>[] : [];
  for (const entry of entityEntries) {
    entries.push({
      accountNumber: Number(entry.accountNumber ?? entry.account ?? 0),
      amount: Number(entry.amount ?? 0),
      type: String(entry.type ?? entry.debitCredit ?? "DEBIT").toUpperCase(),
      description: String(entry.description ?? ""),
    });
  }

  // From accruals array
  const accruals = Array.isArray(entity.accruals) ? entity.accruals as Record<string, unknown>[] : [];
  for (const acc of accruals) {
    const acctNum = Number(acc.accountNumber ?? acc.account ?? 0);
    const amount = Number(acc.amount ?? 0);
    if (acctNum > 0 && amount > 0) {
      entries.push(
        { accountNumber: acctNum, amount, type: "DEBIT", description: String(acc.description ?? "Periodisering") },
        { accountNumber: 2960, amount, type: "CREDIT", description: String(acc.description ?? "Påløpt kostnad") },
      );
    }
  }

  // From additional entities
  for (const e of task.entities.slice(1)) {
    const acctNum = Number(e.accountNumber ?? e.account ?? 0);
    const amount = Number(e.amount ?? 0);
    if (acctNum > 0 && amount !== 0) {
      entries.push({
        accountNumber: acctNum,
        amount,
        type: String(e.type ?? e.debitCredit ?? "DEBIT").toUpperCase(),
        description: String(e.description ?? ""),
      });
    }
  }

  // Handle depreciation if specified
  const depAmount = Number(entity.depreciationAmount ?? 0);
  if (depAmount > 0) {
    const depAssetAccount = Number(entity.depreciationAssetAccount ?? 1200);
    const depExpenseAccount = Number(entity.depreciationExpenseAccount ?? 6010);
    entries.push(
      { accountNumber: depExpenseAccount, amount: depAmount, type: "DEBIT", description: "Månedlig avskrivning" },
      { accountNumber: depAssetAccount, amount: depAmount, type: "CREDIT", description: "Akkumulert avskrivning" },
    );
  }

  if (entries.length === 0) {
    console.warn("[Handler] No monthly closing entries found");
    return;
  }

  // Build voucher
  const postings: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (entry.accountNumber <= 0) continue;
    const account = await findAccount(client, entry.accountNumber);
    const gross = entry.type === "DEBIT" ? Math.abs(entry.amount) : -Math.abs(entry.amount);
    postings.push({
      row: postings.length + 1,
      account: { id: account.id },
      date: dateStr,
      amountGross: gross,
      amountGrossCurrency: gross,
      description: entry.description || "Månedsavslutning",
    });
  }

  // Ensure balance
  const sum = postings.reduce((s, p) => s + (p.amountGross as number), 0);
  if (Math.abs(sum) > 0.01) {
    const balanceAccount = await findAccount(client, 2960);
    postings.push({
      row: postings.length + 1,
      account: { id: balanceAccount.id },
      date: dateStr,
      amountGross: -sum,
      amountGrossCurrency: -sum,
      description: "Motkonto periodisering",
    });
  }

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: dateStr,
    description: `Månedsavslutning ${year}-${String(month).padStart(2, "0")}`,
    postings,
  });
  console.log(`[Handler] Created monthly closing voucher: id=${result.value.id} (${postings.length} postings)`);
}
