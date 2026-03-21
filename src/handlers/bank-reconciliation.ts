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

export function resetBankReconciliationCache(): void {
  accountCache.clear();
}

/**
 * Bank reconciliation handler.
 *
 * Creates adjustment vouchers to reconcile bank balance with ledger.
 * Entities contain the adjustments needed (account, amount, description).
 */
export async function handleBankReconciliation(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const dateStr = String(entity.date ?? today());
  const description = String(entity.description ?? "Bankavstemmelse");

  // Collect adjustments from entities
  const adjustments: { accountNumber: number; amount: number; type: string; description: string }[] = [];

  const entityAdjustments = Array.isArray(entity.adjustments) ? entity.adjustments as Record<string, unknown>[] : [];
  for (const adj of entityAdjustments) {
    const acctNum = Number(adj.accountNumber ?? adj.account ?? 0);
    const amount = Number(adj.amount ?? 0);
    const type = String(adj.type ?? "DEBIT").toUpperCase();
    const desc = String(adj.description ?? "");
    if (acctNum > 0 && amount !== 0) {
      adjustments.push({ accountNumber: acctNum, amount, type, description: desc });
    }
  }

  // Also treat additional entities as adjustment entries
  for (const e of task.entities.slice(1)) {
    const acctNum = Number(e.accountNumber ?? e.account ?? 0);
    const amount = Number(e.amount ?? 0);
    const type = String(e.type ?? e.debitCredit ?? "DEBIT").toUpperCase();
    const desc = String(e.description ?? "");
    if (acctNum > 0 && amount !== 0) {
      adjustments.push({ accountNumber: acctNum, amount, type, description: desc });
    }
  }

  if (adjustments.length === 0) {
    // If no explicit adjustments, try to create a reconciliation voucher from bank/ledger difference
    const bankBalance = Number(entity.bankBalance ?? 0);
    const ledgerBalance = Number(entity.ledgerBalance ?? 0);
    const diff = bankBalance - ledgerBalance;

    if (Math.abs(diff) > 0.01) {
      adjustments.push({
        accountNumber: 1920,
        amount: Math.abs(diff),
        type: diff > 0 ? "DEBIT" : "CREDIT",
        description: "Bankavstemmingsdifferanse",
      });
      adjustments.push({
        accountNumber: 7790,
        amount: Math.abs(diff),
        type: diff > 0 ? "CREDIT" : "DEBIT",
        description: "Bankavstemmingsdifferanse motkonto",
      });
    } else {
      console.log("[Handler] No reconciliation adjustments needed");
      return;
    }
  }

  // Build voucher postings
  const postings: Record<string, unknown>[] = [];
  for (const adj of adjustments) {
    const account = await findAccount(client, adj.accountNumber);
    const gross = adj.type === "DEBIT" ? Math.abs(adj.amount) : -Math.abs(adj.amount);
    postings.push({
      row: postings.length + 1,
      account: { id: account.id },
      date: dateStr,
      amountGross: gross,
      amountGrossCurrency: gross,
      description: adj.description || description,
    });
  }

  // Ensure balance
  const sum = postings.reduce((s, p) => s + (p.amountGross as number), 0);
  if (Math.abs(sum) > 0.01) {
    const bankAccount = await findAccount(client, 1920);
    postings.push({
      row: postings.length + 1,
      account: { id: bankAccount.id },
      date: dateStr,
      amountGross: -sum,
      amountGrossCurrency: -sum,
      description: "Motkonto",
    });
  }

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: dateStr,
    description,
    postings,
  });
  console.log(`[Handler] Created bank reconciliation voucher: id=${result.value.id} (${postings.length} postings)`);
}
