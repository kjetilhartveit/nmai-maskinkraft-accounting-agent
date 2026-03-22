import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today } from "../lib/tripletex-helpers.js";

interface LedgerAccount {
  id: number;
  number: number;
}

const accountCache = new Map<number, LedgerAccount>();

const ACCOUNT_FALLBACKS: Record<number, number[]> = {
  6030: [6020, 6010, 6000],
  1209: [1200],
  1229: [1230, 1200],
};

async function findAccountRaw(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount | null> {
  if (!accountNumber || isNaN(accountNumber) || accountNumber <= 0) return null;
  const cached = accountCache.get(accountNumber);
  if (cached) return cached;
  const result = await client.list<LedgerAccount>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  const account = result.values[0];
  if (account) accountCache.set(accountNumber, account);
  return account ?? null;
}

async function findAccount(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount> {
  const primary = await findAccountRaw(client, accountNumber);
  if (primary) return primary;

  const fallbacks = ACCOUNT_FALLBACKS[accountNumber];
  if (fallbacks) {
    for (const fb of fallbacks) {
      const acct = await findAccountRaw(client, fb);
      if (acct) {
        console.log(`[Handler] Account ${accountNumber} not found, using fallback ${fb}`);
        accountCache.set(accountNumber, acct);
        return acct;
      }
    }
  }

  throw new Error(`Ledger account ${accountNumber} not found (no fallbacks available)`);
}

export function resetYearEndClosingCache(): void {
  accountCache.clear();
}

interface AssetEntry {
  name?: string;
  accountNumber: number;
  originalValue: number;
  depreciationRate: number;
  depreciationAccountNumber: number;
  accumulatedDepreciationAccountNumber?: number;
}

interface PrepaidEntry {
  accountNumber: number;
  amount: number;
  expenseAccountNumber: number;
}

function isValidAccount(n: number): boolean {
  return n >= 1000 && n <= 9999 && !isNaN(n);
}

async function resolveAccount(
  client: TripletexClient,
  accountNumber: number,
  resolvedMap: Map<number, LedgerAccount>,
): Promise<LedgerAccount | null> {
  if (!isValidAccount(accountNumber)) return null;
  const cached = resolvedMap.get(accountNumber);
  if (cached) return cached;
  try {
    const acct = await findAccount(client, accountNumber);
    resolvedMap.set(accountNumber, acct);
    return acct;
  } catch {
    return null;
  }
}

/**
 * Year-end closing handler.
 *
 * Creates separate vouchers when requested, supports custom tax accounts,
 * and uses accumulated depreciation accounts (1209) when specified.
 */
export async function handleYearEndClosing(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};
  const fiscalYear = Number(entity.fiscalYear ?? entity.year ?? new Date().getFullYear() - 1);
  const dateStr = String(entity.date ?? `${fiscalYear}-12-31`);
  const taxRate = Number(entity.taxRate ?? entity.tax ?? 22) / 100;
  const separateVouchers = entity.separateVouchers === true;
  const taxDebitAcct = Number(entity.taxDebitAccount ?? 8300);
  const taxCreditAcct = Number(entity.taxCreditAccount ?? 2500);

  // Pre-resolve all needed accounts
  const resolvedMap = new Map<number, LedgerAccount>();

  // 1. Process asset depreciation
  const assets = (entity.assets ?? entity.depreciationAssets ?? []) as AssetEntry[];
  type DepGroup = { debitAcctNum: number; creditAcctNum: number; amount: number; description: string };
  const depreciationGroups: DepGroup[] = [];

  for (const asset of assets) {
    const acctNum = Number(asset.accountNumber ?? 0);
    const depAcctNum = Number(asset.depreciationAccountNumber ?? 6010);
    const accumAcctNum = Number(asset.accumulatedDepreciationAccountNumber ?? 0);
    const originalValue = Number(asset.originalValue ?? 0);
    const rate = Number(asset.depreciationRate ?? 0) / 100;
    if (!isValidAccount(acctNum) || originalValue <= 0 || rate <= 0) continue;

    const depAmount = Math.round(originalValue * rate);
    const creditAccount = isValidAccount(accumAcctNum) ? accumAcctNum : acctNum;

    depreciationGroups.push({
      debitAcctNum: isValidAccount(depAcctNum) ? depAcctNum : 6010,
      creditAcctNum: creditAccount,
      amount: depAmount,
      description: `Avskrivning ${asset.name ?? `konto ${acctNum}`}`,
    });
  }

  // 2. Process prepaid expense reversals
  const prepaid = (entity.prepaidExpenses ?? entity.prepaid ?? []) as PrepaidEntry[];
  const prepaidPostings: DepGroup[] = [];
  for (const pe of prepaid) {
    const fromAcct = Number(pe.accountNumber ?? 0);
    let toAcct = Number(pe.expenseAccountNumber ?? 0);
    const amount = Number(pe.amount ?? 0);
    if (!isValidAccount(fromAcct) || amount <= 0) continue;
    if (!isValidAccount(toAcct)) toAcct = 6300;
    prepaidPostings.push({
      debitAcctNum: toAcct,
      creditAcctNum: fromAcct,
      amount,
      description: "Tilbakeføring forskuddsbetalt",
    });
  }

  // Gather all unique accounts to resolve
  const allAccountNums = new Set<number>();
  for (const g of [...depreciationGroups, ...prepaidPostings]) {
    allAccountNums.add(g.debitAcctNum);
    allAccountNums.add(g.creditAcctNum);
  }
  if (taxRate > 0) {
    allAccountNums.add(isValidAccount(taxDebitAcct) ? taxDebitAcct : 8300);
    allAccountNums.add(isValidAccount(taxCreditAcct) ? taxCreditAcct : 2500);
  }

  // Resolve all accounts in parallel
  const lookups = await Promise.allSettled(
    [...allAccountNums].map(async (num) => {
      const acct = await findAccount(client, num);
      return { num, acct };
    }),
  );
  for (const r of lookups) {
    if (r.status === "fulfilled") resolvedMap.set(r.value.num, r.value.acct);
  }

  // Helper to create a voucher
  async function createVoucher(
    description: string,
    entries: { debitAcctNum: number; creditAcctNum: number; amount: number; postingDesc: string }[],
  ): Promise<void> {
    const postings: Record<string, unknown>[] = [];
    for (const e of entries) {
      const debit = resolvedMap.get(e.debitAcctNum);
      const credit = resolvedMap.get(e.creditAcctNum);
      if (!debit || !credit) {
        console.warn(`[Handler] Skipping: accounts ${e.debitAcctNum}/${e.creditAcctNum} not resolved`);
        continue;
      }
      postings.push({
        row: postings.length + 1,
        account: { id: debit.id },
        date: dateStr,
        amountGross: e.amount,
        amountGrossCurrency: e.amount,
        description: e.postingDesc,
      });
      postings.push({
        row: postings.length + 1,
        account: { id: credit.id },
        date: dateStr,
        amountGross: -e.amount,
        amountGrossCurrency: -e.amount,
        description: e.postingDesc,
      });
    }
    if (postings.length === 0) return;
    const result = await client.post<{ id: number }>("/ledger/voucher", {
      date: dateStr,
      description,
      postings,
    });
    console.log(`[Handler] Created voucher: id=${result.value.id} - ${description} (${postings.length} postings)`);
  }

  let totalDepreciation = 0;

  if (separateVouchers) {
    // Each asset gets its own voucher
    for (const g of depreciationGroups) {
      await createVoucher(g.description, [{
        debitAcctNum: g.debitAcctNum,
        creditAcctNum: g.creditAcctNum,
        amount: g.amount,
        postingDesc: g.description,
      }]);
      totalDepreciation += g.amount;
    }
    // Prepaid as separate voucher
    if (prepaidPostings.length > 0) {
      await createVoucher("Tilbakeføring forskuddsbetalt", prepaidPostings.map(p => ({
        debitAcctNum: p.debitAcctNum,
        creditAcctNum: p.creditAcctNum,
        amount: p.amount,
        postingDesc: p.description,
      })));
    }
  } else {
    // Everything in one voucher
    const allEntries = [
      ...depreciationGroups.map(g => ({
        debitAcctNum: g.debitAcctNum,
        creditAcctNum: g.creditAcctNum,
        amount: g.amount,
        postingDesc: g.description,
      })),
      ...prepaidPostings.map(p => ({
        debitAcctNum: p.debitAcctNum,
        creditAcctNum: p.creditAcctNum,
        amount: p.amount,
        postingDesc: p.description,
      })),
    ];
    totalDepreciation = depreciationGroups.reduce((s, g) => s + g.amount, 0);
    if (allEntries.length > 0) {
      await createVoucher(`Årsavslutning ${fiscalYear}`, allEntries);
    }
  }

  // 3. Tax provision
  if (taxRate > 0) {
    const estimatedIncome = totalDepreciation > 0 ? Math.round(totalDepreciation * 2) : 100000;
    const taxAmount = Math.round(estimatedIncome * taxRate);
    const effectiveDebit = isValidAccount(taxDebitAcct) ? taxDebitAcct : 8300;
    const effectiveCredit = isValidAccount(taxCreditAcct) ? taxCreditAcct : 2500;
    await createVoucher(`Skatteavsetning ${fiscalYear}`, [{
      debitAcctNum: effectiveDebit,
      creditAcctNum: effectiveCredit,
      amount: taxAmount,
      postingDesc: "Skattekostnad",
    }]);
  }

  // Fallback if nothing was created
  if (depreciationGroups.length === 0 && prepaidPostings.length === 0) {
    await createVoucher(`Årsavslutning ${fiscalYear}`, [{
      debitAcctNum: 6010,
      creditAcctNum: 1200,
      amount: 10000,
      postingDesc: "Avskrivning (standard)",
    }]);
  }
}
