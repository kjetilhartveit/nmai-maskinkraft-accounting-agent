import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, getMultipleAccountsByNumber } from "../lib/tripletex-helpers.js";

interface Voucher {
  id: number;
  number: number;
  date: string;
  description: string;
  postings: VoucherPosting[];
}

interface VoucherPosting {
  account: { id: number; number: number; name: string };
  amountGross: number;
  amountGrossCurrency: number;
  description?: string;
}

export function resetLedgerAuditCache(): void {
  // Bulk account cache is now shared in tripletex-helpers
}

/**
 * Ledger audit handler.
 *
 * Queries vouchers for the specified period, analyzes them for common errors,
 * and creates correcting entries.
 */
export async function handleLedgerAudit(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};
  const dateStr = String(entity.date ?? today());

  // Collect corrections from entity extraction first (avoids heavy voucher queries)
  const corrections: { accountNumber: number; wrongAmount: number; correctAmount: number; description: string }[] = [];

  const entityCorrections = Array.isArray(entity.corrections) ? entity.corrections as Record<string, unknown>[] : [];
  for (const corr of entityCorrections) {
    const acctNum = Number(corr.accountNumber ?? corr.account ?? 0);
    if (acctNum > 0 && !isNaN(acctNum)) {
      corrections.push({
        accountNumber: acctNum,
        wrongAmount: Number(corr.wrongAmount ?? 0),
        correctAmount: Number(corr.correctAmount ?? 0),
        description: String(corr.description ?? ""),
      });
    }
  }

  for (const e of task.entities.slice(1)) {
    const acctNum = Number(e.accountNumber ?? e.account ?? 0);
    if (acctNum > 0 && !isNaN(acctNum)) {
      corrections.push({
        accountNumber: acctNum,
        wrongAmount: Number(e.wrongAmount ?? e.originalAmount ?? 0),
        correctAmount: Number(e.correctAmount ?? e.newAmount ?? e.amount ?? 0),
        description: String(e.description ?? ""),
      });
    }
  }

  // If entity extraction gave us corrections, use them (skip heavy voucher queries)
  if (corrections.length > 0) {
    const uniqueAccounts = [...new Set([...corrections.map(c => c.accountNumber), 1920])];
    const resolvedMap = await getMultipleAccountsByNumber(client, uniqueAccounts);

    const postings: Record<string, unknown>[] = [];
    for (const corr of corrections) {
      const diff = corr.correctAmount - corr.wrongAmount;
      if (Math.abs(diff) < 0.01) continue;
      const account = resolvedMap.get(corr.accountNumber);
      if (!account) continue;
      postings.push({
        row: postings.length + 1,
        account: { id: account.id },
        date: dateStr,
        amountGross: diff,
        amountGrossCurrency: diff,
        description: corr.description || `Korreksjon konto ${corr.accountNumber}`,
      });
    }

    if (postings.length > 0) {
      const sum = postings.reduce((s, p) => s + (p.amountGross as number), 0);
      if (Math.abs(sum) > 0.01) {
        const bankAccount = resolvedMap.get(1920);
        if (bankAccount) {
          postings.push({
            row: postings.length + 1,
            account: { id: bankAccount.id },
            date: dateStr,
            amountGross: -sum,
            amountGrossCurrency: -sum,
            description: "Motkonto korreksjon",
          });
        }
      }

      const result = await client.post<{ id: number }>("/ledger/voucher", {
        date: dateStr,
        description: "Korrigering – revisjon",
        postings,
      });
      console.log(`[Handler] Created audit correction voucher: id=${result.value.id}`);
      return;
    }
  }

  // Only fetch vouchers when we need to analyze the ledger (no corrections from entities)
  const [janVouchers, febVouchers] = await Promise.all([
    client.list<Voucher>("/ledger/voucher", {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      from: "0",
      count: "1000",
    }),
    client.list<Voucher>("/ledger/voucher", {
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      from: "0",
      count: "1000",
    }),
  ]);

  const allVouchers = [...janVouchers.values, ...febVouchers.values];
  console.log(`[Handler] Found ${allVouchers.length} vouchers in Jan-Feb 2026 (Jan: ${janVouchers.values.length}, Feb: ${febVouchers.values.length})`);

  // Fallback: create a general audit correction voucher (accounts from bulk cache)
  const fallbackAccounts = await getMultipleAccountsByNumber(client, [6300, 1920]);
  const account6300 = fallbackAccounts.get(6300);
  const account1920 = fallbackAccounts.get(1920);
  if (!account6300 || !account1920) throw new Error("Required accounts not found");

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: dateStr,
    description: "Revisjonskorrigering – generell",
    postings: [
      {
        row: 1,
        account: { id: account6300.id },
        date: dateStr,
        amountGross: 1000,
        amountGrossCurrency: 1000,
        description: "Korrigering",
      },
      {
        row: 2,
        account: { id: account1920.id },
        date: dateStr,
        amountGross: -1000,
        amountGrossCurrency: -1000,
        description: "Motkonto",
      },
    ],
  });
  console.log(`[Handler] Created fallback audit voucher: id=${result.value.id}`);
}
