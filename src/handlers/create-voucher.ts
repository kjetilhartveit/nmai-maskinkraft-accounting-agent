import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

async function findAccountByNumber(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount | null> {
  const result = await client.list<LedgerAccount>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

function ensureDateFormat(value: unknown): string {
  const s = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return today();
}

export async function handleCreateVoucher(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const voucherDate = ensureDateFormat(entity.date ?? entity.voucherDate ?? today());
  const description = String(entity.description ?? entity.comment ?? "");

  // Build postings from entity
  const postingEntities: Array<Record<string, unknown>> = Array.isArray(
    entity.postings,
  )
    ? (entity.postings as Array<Record<string, unknown>>)
    : [];

  // Also collect subsequent entities as postings
  for (const e of task.entities.slice(1)) {
    postingEntities.push(e);
  }

  const postings: Record<string, unknown>[] = [];
  for (const posting of postingEntities) {
    const accountNumber = Number(
      posting.accountNumber ?? posting.account ?? 0,
    );
    if (!accountNumber) continue;

    const account = await findAccountByNumber(client, accountNumber);
    if (!account) {
      console.warn(`[Handler] Ledger account not found: ${accountNumber}`);
      continue;
    }

    const amount = Number(posting.amount ?? 0);
    const type = String(posting.type ?? posting.debitCredit ?? "DEBIT").toUpperCase();

    const gross = type === "DEBIT" ? Math.abs(amount) : -Math.abs(amount);
    postings.push({
      row: postings.length + 1,
      account: { id: account.id },
      date: voucherDate,
      amountGross: gross,
      amountGrossCurrency: gross,
      description: String(posting.description ?? description),
    });
  }

  if (postings.length === 0) {
    console.warn("[Handler] No valid postings for voucher");
    return;
  }

  // Ensure postings balance to zero — Tripletex requires balanced vouchers
  const sum = postings.reduce((s, p) => s + (p.amountGross as number), 0);
  if (Math.abs(sum) > 0.01) {
    // Auto-add balancing entry: if net is positive (debit surplus), credit a cash/bank account;
    // if net is negative (credit surplus), debit a cash/bank account.
    const balanceAccountNumber = sum > 0 ? 1920 : 1920; // Bank account
    const balanceAccount = await findAccountByNumber(client, balanceAccountNumber);
    if (balanceAccount) {
      postings.push({
        row: postings.length + 1,
        account: { id: balanceAccount.id },
        date: voucherDate,
        amountGross: -sum,
        amountGrossCurrency: -sum,
        description: description || "Motkonto",
      });
      console.log(`[Handler] Added balancing entry: account ${balanceAccountNumber}, amount ${-sum}`);
    } else {
      console.warn(`[Handler] Could not find balance account ${balanceAccountNumber}, voucher may fail`);
    }
  }

  const body: Record<string, unknown> = {
    date: voucherDate,
    description,
    postings,
  };

  console.log(`[Handler] Creating voucher with date=${voucherDate}, ${postings.length} posting(s)`);
  const result = await client.post<{ id: number }>("/ledger/voucher", body);
  console.log(`[Handler] Created voucher: id=${result.value.id}`);
}
