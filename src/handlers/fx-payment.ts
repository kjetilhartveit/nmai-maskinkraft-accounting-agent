import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, loadAllAccounts } from "../lib/tripletex-helpers.js";

interface Invoice {
  id: number;
  invoiceNumber: number;
  amountOutstanding: number;
  amountOutstandingTotal: number;
}

interface PaymentType {
  id: number;
  description: string;
}

let cachedPaymentTypeId: number | null = null;

async function getPaymentTypeId(client: TripletexClient): Promise<number> {
  if (cachedPaymentTypeId) return cachedPaymentTypeId;
  const result = await client.list<PaymentType>("/invoice/paymentType", {
    from: "0",
    count: "10",
  });
  if (result.values.length > 0) {
    cachedPaymentTypeId = result.values[0].id;
    return cachedPaymentTypeId;
  }
  throw new Error("No payment types available");
}

export function resetFxPaymentCache(): void {
  cachedPaymentTypeId = null;
}

/**
 * Foreign currency payment handler.
 *
 * Handles: Invoice sent in foreign currency at OLD_RATE. Customer paid at NEW_RATE.
 * Posts exchange difference (agio/disagio).
 *
 * Optimized flow (5 API calls):
 *   1. Parallel: find invoices (by customer name) + payment types + all accounts
 *   2. Register payment
 *   3. Post exchange difference voucher
 */
export async function handleFxPayment(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const customerName = String(entity.customerName ?? entity.supplierName ?? entity.supplier ?? "");
  const orgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
  const eurAmount = Number(entity.invoiceAmountForeign ?? entity.foreignAmount ?? entity.amount ?? 0);
  const currency = String(entity.currency ?? entity.foreignCurrency ?? "EUR");
  const invoiceRate = Number(entity.invoiceRate ?? entity.exchangeRate ?? 0);
  const paymentRate = Number(entity.paymentRate ?? 0);

  const invoiceNok = eurAmount * invoiceRate;
  const paymentNok = eurAmount * paymentRate;
  const diff = paymentNok - invoiceNok;

  console.log(`[Handler] FX: ${eurAmount} ${currency}, invoice rate ${invoiceRate}, payment rate ${paymentRate}`);
  console.log(`[Handler] FX: invoice NOK=${invoiceNok}, payment NOK=${paymentNok}, diff=${diff}`);

  // 1. Parallel: find invoices by customer name + payment types + all ledger accounts
  const [invoices, _paymentTypeId, accounts] = await Promise.all([
    client.list<Invoice>("/invoice", {
      customerName: customerName || undefined,
      invoiceDateFrom: "2025-01-01",
      invoiceDateTo: "2026-12-31",
      from: "0",
      count: "20",
    } as Record<string, string>),
    getPaymentTypeId(client),
    loadAllAccounts(client),
  ]);

  const payTypeId = _paymentTypeId;

  // 2. Register payment on unpaid invoice
  let invoicePaid = false;
  const unpaid = invoices.values.find(inv => inv.amountOutstanding > 0 || inv.amountOutstandingTotal > 0);
  if (unpaid && payTypeId) {
    console.log(`[Handler] Found unpaid invoice: #${unpaid.invoiceNumber} (outstanding: ${unpaid.amountOutstandingTotal})`);
    const paidAmount = paymentNok > 0 ? paymentNok : Math.round(unpaid.amountOutstandingTotal * (paymentRate || 1));
    await client.put(
      `/invoice/${unpaid.id}/:payment?paymentDate=${today()}&paymentTypeId=${payTypeId}&paidAmount=${paidAmount}`,
      {},
    );
    console.log(`[Handler] Registered FX payment: ${paidAmount} NOK`);
    invoicePaid = true;
  }

  // 3. Post exchange difference voucher
  if (Math.abs(diff) > 0.01) {
    const isLoss = diff < 0;
    const absDiff = Math.abs(Math.round(diff));
    const fxAccount = accounts.get(isLoss ? 8160 : 8060);
    const bankAccount = accounts.get(1920);
    if (!fxAccount) throw new Error(`Ledger account ${isLoss ? 8160 : 8060} not found`);
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
  } else if (!invoicePaid) {
    const bankAccount = accounts.get(1920);
    const fxAccount = accounts.get(8160);
    if (!fxAccount) throw new Error("Ledger account 8160 not found");
    if (!bankAccount) throw new Error("Ledger account 1920 not found");
    const amount = paymentNok > 0 ? paymentNok : 1000;
    const result = await client.post<{ id: number }>("/ledger/voucher", {
      date: today(),
      description: `Valutabetaling ${eurAmount} ${currency}`,
      postings: [
        { row: 1, account: { id: bankAccount.id }, date: today(), amountGross: amount, amountGrossCurrency: amount, description: `${currency} betaling` },
        { row: 2, account: { id: fxAccount.id }, date: today(), amountGross: -amount, amountGrossCurrency: -amount, description: `${currency} betaling` },
      ],
    });
    console.log(`[Handler] Created fallback FX voucher: id=${result.value.id}`);
  }
}
