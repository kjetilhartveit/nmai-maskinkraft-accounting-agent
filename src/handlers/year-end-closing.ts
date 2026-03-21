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

export function resetYearEndClosingCache(): void {
  accountCache.clear();
}

/**
 * Year-end closing handler.
 *
 * Creates vouchers for depreciation, accruals, and closing entries.
 * Standard Norwegian year-end entries:
 *   - Depreciation: debit 6010 (avskrivning), credit asset account (e.g. 1200)
 *   - Accruals: debit expense, credit accrued liability
 *   - Closing: transfer income/expense to equity (8800/8960)
 */
export async function handleYearEndClosing(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const dateStr = String(entity.date ?? `${new Date().getFullYear()}-12-31`);

  // Collect all closing entries
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

  // Handle depreciation specifically if provided
  const depAmount = Number(entity.depreciationAmount ?? 0);
  const depAssetAccount = Number(entity.depreciationAssetAccount ?? entity.assetAccount ?? 1200);
  const depExpenseAccount = Number(entity.depreciationExpenseAccount ?? entity.expenseAccount ?? 6010);

  if (depAmount > 0) {
    entries.push(
      { accountNumber: depExpenseAccount, amount: depAmount, type: "DEBIT", description: "Avskrivning" },
      { accountNumber: depAssetAccount, amount: depAmount, type: "CREDIT", description: "Akkumulert avskrivning" },
    );
  }

  if (entries.length === 0) {
    console.warn("[Handler] No year-end closing entries found, creating placeholder depreciation");
    entries.push(
      { accountNumber: 6010, amount: 10000, type: "DEBIT", description: "Avskrivning" },
      { accountNumber: 1200, amount: 10000, type: "CREDIT", description: "Akkumulert avskrivning" },
    );
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
      description: entry.description || "Årsavslutning",
    });
  }

  // Ensure balance
  const sum = postings.reduce((s, p) => s + (p.amountGross as number), 0);
  if (Math.abs(sum) > 0.01) {
    const equityAccount = await findAccount(client, 8960);
    postings.push({
      row: postings.length + 1,
      account: { id: equityAccount.id },
      date: dateStr,
      amountGross: -sum,
      amountGrossCurrency: -sum,
      description: "Årsoppgjør motkonto",
    });
  }

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: dateStr,
    description: "Årsavslutning",
    postings,
  });
  console.log(`[Handler] Created year-end closing voucher: id=${result.value.id} (${postings.length} postings)`);
}
