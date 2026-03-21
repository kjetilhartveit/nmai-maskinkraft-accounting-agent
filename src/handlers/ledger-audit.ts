import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

async function findAccount(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount> {
  const result = await client.list<LedgerAccount>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  const account = result.values[0];
  if (!account) throw new Error(`Ledger account ${accountNumber} not found`);
  return account;
}

/**
 * Ledger audit handler.
 *
 * Creates correcting voucher entries to fix errors discovered in the ledger.
 * Each correction reverses the wrong entry and books the correct one.
 */
export async function handleLedgerAudit(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const dateStr = String(entity.date ?? today());
  const description = String(entity.description ?? entity.originalVoucherDescription ?? "Korrigeringsbilag");

  // Collect corrections from the corrections array in the first entity
  const corrections: { accountNumber: number; wrongAmount: number; correctAmount: number; description: string }[] = [];

  const entityCorrections = Array.isArray(entity.corrections) ? entity.corrections as Record<string, unknown>[] : [];
  for (const corr of entityCorrections) {
    corrections.push({
      accountNumber: Number(corr.accountNumber ?? corr.account ?? 0),
      wrongAmount: Number(corr.wrongAmount ?? 0),
      correctAmount: Number(corr.correctAmount ?? 0),
      description: String(corr.description ?? ""),
    });
  }

  // Also treat additional entities as corrections
  for (const e of task.entities.slice(1)) {
    const acctNum = Number(e.accountNumber ?? e.account ?? 0);
    if (acctNum > 0) {
      corrections.push({
        accountNumber: acctNum,
        wrongAmount: Number(e.wrongAmount ?? e.originalAmount ?? 0),
        correctAmount: Number(e.correctAmount ?? e.newAmount ?? e.amount ?? 0),
        description: String(e.description ?? ""),
      });
    }
  }

  if (corrections.length === 0) {
    // Fallback: if entities have posting-style data, create a simple correcting voucher
    const postingEntities: Record<string, unknown>[] = [];
    for (const e of task.entities) {
      if (e.accountNumber || e.account) {
        postingEntities.push(e);
      }
    }

    if (postingEntities.length > 0) {
      const postings: Record<string, unknown>[] = [];
      for (const pe of postingEntities) {
        const acctNum = Number(pe.accountNumber ?? pe.account ?? 0);
        const amount = Number(pe.amount ?? 0);
        const type = String(pe.type ?? pe.debitCredit ?? "DEBIT").toUpperCase();
        const account = await findAccount(client, acctNum);
        const gross = type === "DEBIT" ? Math.abs(amount) : -Math.abs(amount);
        postings.push({
          row: postings.length + 1,
          account: { id: account.id },
          date: dateStr,
          amountGross: gross,
          amountGrossCurrency: gross,
          description: String(pe.description ?? description),
        });
      }

      // Balance if needed
      const sum = postings.reduce((s, p) => s + (p.amountGross as number), 0);
      if (Math.abs(sum) > 0.01) {
        const bankAccount = await findAccount(client, 1920);
        postings.push({
          row: postings.length + 1,
          account: { id: bankAccount.id },
          date: dateStr,
          amountGross: -sum,
          amountGrossCurrency: -sum,
          description: "Motkonto korreksjon",
        });
      }

      const result = await client.post<{ id: number }>("/ledger/voucher", {
        date: dateStr,
        description,
        postings,
      });
      console.log(`[Handler] Created audit correction voucher: id=${result.value.id}`);
      return;
    }

    console.warn("[Handler] No corrections found for ledger audit");
    return;
  }

  // Create correcting voucher entries for each correction
  const postings: Record<string, unknown>[] = [];

  for (const corr of corrections) {
    if (corr.accountNumber <= 0) continue;
    const account = await findAccount(client, corr.accountNumber);
    const diff = corr.correctAmount - corr.wrongAmount;

    if (Math.abs(diff) < 0.01) continue;

    postings.push({
      row: postings.length + 1,
      account: { id: account.id },
      date: dateStr,
      amountGross: diff,
      amountGrossCurrency: diff,
      description: corr.description || `Korreksjon konto ${corr.accountNumber}`,
    });
  }

  if (postings.length === 0) {
    console.warn("[Handler] No non-zero corrections for ledger audit");
    return;
  }

  // Add balancing entry
  const sum = postings.reduce((s, p) => s + (p.amountGross as number), 0);
  if (Math.abs(sum) > 0.01) {
    const bankAccount = await findAccount(client, 1920);
    postings.push({
      row: postings.length + 1,
      account: { id: bankAccount.id },
      date: dateStr,
      amountGross: -sum,
      amountGrossCurrency: -sum,
      description: "Motkonto korreksjon",
    });
  }

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: dateStr,
    description: `Korrigering: ${description}`,
    postings,
  });
  console.log(`[Handler] Created ledger audit correction voucher: id=${result.value.id} (${corrections.length} correction(s))`);
}
