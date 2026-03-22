import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, loadAllAccounts } from "../lib/tripletex-helpers.js";

interface Invoice {
  id: number;
  invoiceNumber: number;
  amountOutstanding: number;
  amountOutstandingTotal: number;
  customer?: { id: number; name: string };
}

/**
 * Foreign currency payment handler.
 *
 * Handles: Invoice sent in foreign currency at OLD_RATE. Customer paid at NEW_RATE.
 * Posts exchange difference (agio/disagio) as a voucher.
 *
 * Optimized flow (3 API calls):
 *   1. Parallel: GET /invoice (find by customer) + GET /ledger/account (all accounts)
 *   2. POST /ledger/voucher (FX difference)
 */
export async function handleFxPayment(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const customerName = String(entity.customerName ?? entity.supplierName ?? entity.supplier ?? "");
  const eurAmount = Number(entity.invoiceAmountForeign ?? entity.foreignAmount ?? entity.amount ?? 0);
  const currency = String(entity.currency ?? entity.foreignCurrency ?? "EUR");
  const invoiceRate = Number(entity.invoiceRate ?? entity.exchangeRate ?? 0);
  const paymentRate = Number(entity.paymentRate ?? 0);

  const invoiceNok = eurAmount * invoiceRate;
  const paymentNok = eurAmount * paymentRate;
  const diff = paymentNok - invoiceNok;

  console.log(`[Handler] FX: ${eurAmount} ${currency}, invoice rate ${invoiceRate}, payment rate ${paymentRate}`);
  console.log(`[Handler] FX: invoice NOK=${invoiceNok}, payment NOK=${paymentNok}, diff=${diff}`);

  // 1. Parallel: find invoices + load all ledger accounts
  const [invoices, accounts] = await Promise.all([
    client.list<Invoice>("/invoice", {
      customerName: customerName || undefined,
      invoiceDateFrom: "2025-01-01",
      invoiceDateTo: "2026-12-31",
      from: "0",
      count: "20",
    } as Record<string, string>),
    loadAllAccounts(client),
  ]);

  const unpaid = invoices.values.find(inv => inv.amountOutstanding > 0 || inv.amountOutstandingTotal > 0);
  if (unpaid) {
    console.log(`[Handler] Found unpaid invoice: #${unpaid.invoiceNumber} (outstanding: ${unpaid.amountOutstandingTotal})`);
  }

  // 2. Post FX voucher
  const isLoss = diff < 0;
  const absDiff = Math.abs(Math.round(diff));
  const fxAccountNum = isLoss ? 8160 : 8060;
  const fxAccount = accounts.get(fxAccountNum);
  const bankAccount = accounts.get(1920);
  if (!fxAccount) throw new Error(`Ledger account ${fxAccountNum} not found`);
  if (!bankAccount) throw new Error("Ledger account 1920 not found");

  const postings = isLoss
    ? [
        { row: 1, account: { id: fxAccount.id }, date: today(), amountGross: absDiff, amountGrossCurrency: absDiff, description: "Valutatap (disagio)" },
        { row: 2, account: { id: bankAccount.id }, date: today(), amountGross: -absDiff, amountGrossCurrency: -absDiff, description: "Disagio" },
      ]
    : [
        { row: 1, account: { id: bankAccount.id }, date: today(), amountGross: absDiff, amountGrossCurrency: absDiff, description: "Agio" },
        { row: 2, account: { id: fxAccount.id }, date: today(), amountGross: -absDiff, amountGrossCurrency: -absDiff, description: "Valutagevinst (agio)" },
      ];

  const result = await client.post<{ id: number }>("/ledger/voucher", {
    date: today(),
    description: `Valutajustering ${eurAmount} ${currency} (${isLoss ? "disagio" : "agio"}: ${absDiff} NOK)`,
    postings,
  });
  console.log(`[Handler] Created FX voucher: id=${result.value.id} (${isLoss ? "disagio" : "agio"}: ${absDiff} NOK)`);
}

export function resetFxPaymentCache(): void {
  // No module-level caches remaining
}
