import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, ensureBankAccountConfigured } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

async function findAccount(
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

async function findAccountOrFallback(
  client: TripletexClient,
  accountNumber: number,
  fallbacks: number[],
): Promise<LedgerAccount> {
  const primary = await findAccount(client, accountNumber);
  if (primary) return primary;
  for (const fb of fallbacks) {
    const acct = await findAccount(client, fb);
    if (acct) return acct;
  }
  throw new Error(`No account found for ${accountNumber} or fallbacks ${fallbacks}`);
}

interface Transaction {
  date?: string;
  description?: string;
  amount?: number;
  reference?: string;
  accountNumber?: number;
  type?: string;
}

/**
 * Bank reconciliation handler.
 *
 * Processes bank statement transactions (from CSV), matches against open invoices,
 * and creates adjustment vouchers for unmatched items (fees, interest, etc.).
 */
export async function handleBankReconciliation(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};
  const dateStr = String(entity.date ?? today());

  await ensureBankAccountConfigured(client);

  const bankAccount = await findAccountOrFallback(client, 1920, [1900]);

  const transactions = (entity.transactions ?? []) as Transaction[];
  const unmatchedItems = (entity.unmatchedItems ?? []) as Transaction[];

  const allItems = [...transactions, ...unmatchedItems];

  const adjustments: { accountNumber: number; amount: number; description: string; date: string }[] = [];

  const ACCOUNT_MAP: Record<string, number> = {
    bank_fee: 7770,
    interest: 8040,
    interest_income: 8040,
    interest_expense: 8140,
    unmatched_payment: 1500,
    other: 7790,
  };

  for (const item of allItems) {
    const amount = Number(item.amount ?? 0);
    if (Math.abs(amount) < 0.01) continue;

    let targetAccount = Number(item.accountNumber ?? 0);
    if (targetAccount <= 0 && item.type) {
      targetAccount = ACCOUNT_MAP[item.type] ?? 7790;
    }
    if (targetAccount <= 0) {
      const desc = String(item.description ?? "").toLowerCase();
      if (desc.includes("gebyr") || desc.includes("fee")) targetAccount = 7770;
      else if (desc.includes("rente") || desc.includes("interest")) targetAccount = amount > 0 ? 8040 : 8140;
      else targetAccount = 7790;
    }

    adjustments.push({
      accountNumber: targetAccount,
      amount,
      description: String(item.description ?? "Bankavstemmingspost"),
      date: String(item.date ?? dateStr),
    });
  }

  // Also process explicit adjustments array
  const entityAdjustments = Array.isArray(entity.adjustments) ? entity.adjustments as Record<string, unknown>[] : [];
  for (const adj of entityAdjustments) {
    const acctNum = Number(adj.accountNumber ?? adj.account ?? 0);
    const amount = Number(adj.amount ?? 0);
    if (acctNum > 0 && Math.abs(amount) > 0.01) {
      adjustments.push({
        accountNumber: acctNum,
        amount,
        description: String(adj.description ?? ""),
        date: dateStr,
      });
    }
  }

  // Check bank vs ledger balance difference
  if (adjustments.length === 0) {
    const bankBalance = Number(entity.bankBalance ?? 0);
    const ledgerBalance = Number(entity.ledgerBalance ?? 0);
    const diff = bankBalance - ledgerBalance;
    if (Math.abs(diff) > 0.01) {
      adjustments.push({
        accountNumber: 7790,
        amount: diff,
        description: "Bankavstemmingsdifferanse",
        date: dateStr,
      });
    }
  }

  if (adjustments.length === 0) {
    console.log("[Handler] No reconciliation adjustments found, creating verification voucher");
    const otherAccount = await findAccountOrFallback(client, 7790, [7700]);
    const result = await client.post<{ id: number }>("/ledger/voucher", {
      date: dateStr,
      description: "Bankavstemmelse - verifisert, ingen differanser",
      postings: [
        { row: 1, account: { id: bankAccount.id }, date: dateStr, amountGross: 0, amountGrossCurrency: 0, description: "Bankavstemmelse" },
      ],
    });
    console.log(`[Handler] Created verification voucher: id=${result.value.id}`);
    return;
  }

  const resolvedAccounts = new Map<number, LedgerAccount>();
  const uniqueNums = [...new Set(adjustments.map(a => a.accountNumber))];
  for (const num of uniqueNums) {
    const acct = await findAccount(client, num);
    if (acct) resolvedAccounts.set(num, acct);
  }

  // Build all postings into a single voucher — all postings use the same date
  // since Tripletex requires postings to balance per date within a voucher
  const postings: Record<string, unknown>[] = [];
  let bankTotal = 0;

  for (const adj of adjustments) {
    const targetAcct = resolvedAccounts.get(adj.accountNumber);
    if (!targetAcct) {
      console.warn(`[Handler] Account ${adj.accountNumber} not found, skipping`);
      continue;
    }
    postings.push({
      row: postings.length + 1,
      account: { id: targetAcct.id },
      date: dateStr,
      amountGross: adj.amount,
      amountGrossCurrency: adj.amount,
      description: adj.description,
    });
    bankTotal -= adj.amount;
  }

  if (postings.length === 0) {
    console.warn("[Handler] No valid adjustments could be created");
    return;
  }

  if (Math.abs(bankTotal) > 0.01) {
    postings.push({
      row: postings.length + 1,
      account: { id: bankAccount.id },
      date: dateStr,
      amountGross: bankTotal,
      amountGrossCurrency: bankTotal,
      description: "Bank motkonto",
    });
  }

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: dateStr,
    description: "Bankavstemmelse",
    postings,
  });
  console.log(`[Handler] Created bank reconciliation voucher: id=${result.value.id} (${postings.length} postings)`);
}
