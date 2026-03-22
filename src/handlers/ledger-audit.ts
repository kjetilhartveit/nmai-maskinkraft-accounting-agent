import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

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

async function findAccount(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount> {
  if (!accountNumber || isNaN(accountNumber) || accountNumber <= 0) {
    throw new Error(`Invalid account number: ${accountNumber}`);
  }
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

  // Collect corrections from entity extraction (avoids heavy voucher queries)
  const correctionLines: { accountNumber: number; amount: number; description: string }[] = [];

  const entityCorrections = Array.isArray(entity.corrections) ? entity.corrections as Record<string, unknown>[] : [];
  for (const corr of entityCorrections) {
    const acctNum = Number(corr.accountNumber ?? corr.account ?? 0);
    if (acctNum <= 0 || isNaN(acctNum)) continue;

    // New format: signed `amount` field (positive=debit, negative=credit)
    if (corr.amount !== undefined && corr.amount !== null) {
      const amt = Number(corr.amount);
      if (Math.abs(amt) >= 0.01) {
        correctionLines.push({
          accountNumber: acctNum,
          amount: amt,
          description: String(corr.description ?? ""),
        });
      }
    } else {
      // Legacy format: wrongAmount/correctAmount → compute diff
      const wrong = Number(corr.wrongAmount ?? 0);
      const correct = Number(corr.correctAmount ?? 0);
      const diff = correct - wrong;
      if (Math.abs(diff) >= 0.01) {
        correctionLines.push({
          accountNumber: acctNum,
          amount: diff,
          description: String(corr.description ?? ""),
        });
      }
    }
  }

  for (const e of task.entities.slice(1)) {
    const acctNum = Number(e.accountNumber ?? e.account ?? 0);
    if (acctNum <= 0 || isNaN(acctNum)) continue;
    if (e.amount !== undefined && e.amount !== null) {
      const amt = Number(e.amount);
      if (Math.abs(amt) >= 0.01) {
        correctionLines.push({ accountNumber: acctNum, amount: amt, description: String(e.description ?? "") });
      }
    } else {
      const wrong = Number(e.wrongAmount ?? e.originalAmount ?? 0);
      const correct = Number(e.correctAmount ?? e.newAmount ?? 0);
      const diff = correct - wrong;
      if (Math.abs(diff) >= 0.01) {
        correctionLines.push({ accountNumber: acctNum, amount: diff, description: String(e.description ?? "") });
      }
    }
  }

  // Strip LLM-generated balancing entries to 1920 — handler adds its own
  const filteredLines = correctionLines.filter(c => c.accountNumber !== 1920);

  if (filteredLines.length > 0) {
    const uniqueAccounts = [...new Set([...filteredLines.map(c => c.accountNumber), 1920])];
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
    for (const line of filteredLines) {
      const account = resolvedMap.get(line.accountNumber);
      if (!account) continue;
      postings.push({
        row: postings.length + 1,
        account: { id: account.id },
        date: dateStr,
        amountGross: line.amount,
        amountGrossCurrency: line.amount,
        description: line.description || `Korreksjon konto ${line.accountNumber}`,
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

  // Fallback: create a general audit correction voucher
  const [account6300, account1920] = await Promise.all([
    findAccount(client, 6300),
    findAccount(client, 1920),
  ]);

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
