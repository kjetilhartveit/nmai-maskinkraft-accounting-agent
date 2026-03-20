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

export async function handleCreateVoucher(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const voucherDate = String(entity.date ?? entity.voucherDate ?? today());
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

    postings.push({
      account: { id: account.id },
      date: voucherDate,
      amount: type === "DEBIT" ? Math.abs(amount) : -Math.abs(amount),
      description: String(posting.description ?? description),
    });
  }

  if (postings.length === 0) {
    console.warn("[Handler] No valid postings for voucher");
    return;
  }

  const body: Record<string, unknown> = {
    date: voucherDate,
    description,
    postings,
  };

  const result = await client.post<{ id: number }>("/ledger/voucher", body);
  console.log(`[Handler] Created voucher: id=${result.value.id}`);
}
