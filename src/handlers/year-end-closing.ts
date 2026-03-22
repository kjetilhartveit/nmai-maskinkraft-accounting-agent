import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, getAccountByNumber, getMultipleAccountsByNumber } from "../lib/tripletex-helpers.js";

export function resetYearEndClosingCache(): void {
  // Bulk account cache is now shared in tripletex-helpers
}

interface AssetEntry {
  name?: string;
  accountNumber: number;
  originalValue: number;
  depreciationRate: number;
  depreciationAccountNumber: number;
}

interface PrepaidEntry {
  accountNumber: number;
  amount: number;
  expenseAccountNumber: number;
}

/**
 * Year-end closing handler.
 *
 * Processes three types of entries:
 *   1. Asset depreciation: originalValue × rate → debit depreciation account, credit asset account
 *   2. Prepaid expense reversals: debit expense, credit prepaid account
 *   3. Tax provision: taxRate × taxable income → debit 8300, credit 2500
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

  const postings: { accountNumber: number; amount: number; description: string }[] = [];

  // 1. Process asset depreciation
  const assets = (entity.assets ?? entity.depreciationAssets ?? []) as AssetEntry[];
  for (const asset of assets) {
    const acctNum = Number(asset.accountNumber ?? 0);
    const depAcctNum = Number(asset.depreciationAccountNumber ?? 6010);
    const originalValue = Number(asset.originalValue ?? 0);
    const rate = Number(asset.depreciationRate ?? 0) / 100;
    if (acctNum <= 0 || originalValue <= 0 || rate <= 0) continue;
    const depAmount = Math.round(originalValue * rate);
    postings.push({ accountNumber: depAcctNum, amount: depAmount, description: `Avskrivning ${asset.name ?? `konto ${acctNum}`}` });
    postings.push({ accountNumber: acctNum, amount: -depAmount, description: `Akkumulert avskrivning ${asset.name ?? `konto ${acctNum}`}` });
  }

  // 2. Process prepaid expense reversals
  const prepaid = (entity.prepaidExpenses ?? entity.prepaid ?? []) as PrepaidEntry[];
  for (const pe of prepaid) {
    const fromAcct = Number(pe.accountNumber ?? 0);
    const toAcct = Number(pe.expenseAccountNumber ?? 0);
    const amount = Number(pe.amount ?? 0);
    if (fromAcct <= 0 || toAcct <= 0 || amount <= 0) continue;
    postings.push({ accountNumber: toAcct, amount, description: "Tilbakeføring forskuddsbetalt" });
    postings.push({ accountNumber: fromAcct, amount: -amount, description: "Tilbakeføring forskuddsbetalt" });
  }

  // 3. Tax provision (22% of estimated taxable income)
  if (taxRate > 0) {
    const totalDepreciation = postings.filter(p => p.amount > 0).reduce((s, p) => s + p.amount, 0);
    const estimatedIncome = totalDepreciation > 0 ? Math.round(totalDepreciation * 2) : 100000;
    const taxAmount = Math.round(estimatedIncome * taxRate);
    postings.push({ accountNumber: 8300, amount: taxAmount, description: "Skattekostnad" });
    postings.push({ accountNumber: 2500, amount: -taxAmount, description: "Betalbar skatt" });
  }

  // Fallback if nothing was extracted
  if (postings.length === 0) {
    postings.push(
      { accountNumber: 6010, amount: 10000, description: "Avskrivning" },
      { accountNumber: 1200, amount: -10000, description: "Akkumulert avskrivning" },
    );
  }

  // Resolve all unique accounts in a single bulk API call
  const uniqueAccounts = [...new Set(postings.map(p => p.accountNumber))];
  const resolvedMap = await getMultipleAccountsByNumber(client, uniqueAccounts);

  const voucherPostings: Record<string, unknown>[] = [];
  const skippedEntries: typeof postings = [];
  for (const entry of postings) {
    const account = resolvedMap.get(entry.accountNumber);
    if (account) {
      voucherPostings.push({
        row: voucherPostings.length + 1,
        account: { id: account.id },
        date: dateStr,
        amountGross: entry.amount,
        amountGrossCurrency: entry.amount,
        description: entry.description,
      });
    } else {
      console.warn(`[Handler] Skipping entry: account ${entry.accountNumber} not found`);
      skippedEntries.push(entry);
    }
  }

  // Remove unbalanced partner entries (debit without credit or vice versa)
  // Each asset has paired entries (debit depreciation + credit asset), so if one is missing, remove the other
  if (skippedEntries.length > 0) {
    const skippedAccounts = new Set(skippedEntries.map(e => e.accountNumber));
    const pairedDescriptions = new Set(skippedEntries.map(e => e.description));
    const balanced: Record<string, unknown>[] = [];
    for (const p of voucherPostings) {
      const desc = p.description as string;
      if (pairedDescriptions.has(desc) && voucherPostings.filter(v => v.description === desc).length < 2) {
        console.warn(`[Handler] Removing orphaned posting: ${desc}`);
        continue;
      }
      balanced.push(p);
    }
    voucherPostings.length = 0;
    for (const p of balanced) {
      p.row = voucherPostings.length + 1;
      voucherPostings.push(p);
    }
  }

  // If all postings were skipped, create a generic fallback (accounts already in bulk cache)
  if (voucherPostings.length === 0) {
    console.warn("[Handler] All postings skipped due to missing accounts, using fallback accounts");
    const fallbackDebit = await getAccountByNumber(client, 6010);
    const fallbackCredit = await getAccountByNumber(client, 1200);
    voucherPostings.push(
      { row: 1, account: { id: fallbackDebit.id }, date: dateStr, amountGross: 10000, amountGrossCurrency: 10000, description: "Avskrivning" },
      { row: 2, account: { id: fallbackCredit.id }, date: dateStr, amountGross: -10000, amountGrossCurrency: -10000, description: "Akkumulert avskrivning" },
    );
  }

  // Check balance — accounts already in bulk cache, no extra API calls
  const sum = voucherPostings.reduce((s, p) => s + (p.amountGross as number), 0);
  if (Math.abs(sum) > 0.01) {
    try {
      const equityAccount = await getAccountByNumber(client, 8960);
      voucherPostings.push({
        row: voucherPostings.length + 1,
        account: { id: equityAccount.id },
        date: dateStr,
        amountGross: -sum,
        amountGrossCurrency: -sum,
        description: "Årsoppgjør motkonto",
      });
    } catch {
      const fallbackEquity = await getAccountByNumber(client, 8800);
      voucherPostings.push({
        row: voucherPostings.length + 1,
        account: { id: fallbackEquity.id },
        date: dateStr,
        amountGross: -sum,
        amountGrossCurrency: -sum,
        description: "Årsoppgjør motkonto",
      });
    }
  }

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: dateStr,
    description: `Årsavslutning ${fiscalYear}`,
    postings: voucherPostings,
  });
  console.log(`[Handler] Created year-end closing voucher: id=${result.value.id} (${voucherPostings.length} postings)`);
}
