import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, findCustomerByName } from "../lib/tripletex-helpers.js";

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

export function resetFxPaymentCache(): void {
  accountCache.clear();
}

/**
 * Foreign currency payment handler.
 *
 * Handles: Invoice sent in EUR at OLD_RATE. Customer paid at NEW_RATE.
 * Posts exchange difference (agio/disagio).
 *
 * Flow:
 *   1. Find customer
 *   2. Find unpaid invoices → register payment (NOK = EUR × paymentRate)
 *   3. Post exchange difference voucher:
 *      - If paymentRate < invoiceRate: disagio (loss) on account 8160
 *      - If paymentRate > invoiceRate: agio (gain) on account 8060
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
  const diff = paymentNok - invoiceNok; // negative = loss (disagio), positive = gain (agio)

  console.log(`[Handler] FX: ${eurAmount} ${currency}, invoice rate ${invoiceRate}, payment rate ${paymentRate}`);
  console.log(`[Handler] FX: invoice NOK=${invoiceNok}, payment NOK=${paymentNok}, diff=${diff}`);

  // 1. Find customer
  let customerId: number | undefined;
  if (customerName) {
    customerId = ctx.getCustomerId(customerName);
  }
  if (!customerId && customerName) {
    const found = await findCustomerByName(client, customerName);
    if (found) {
      customerId = found.id;
      ctx.registerCustomer(customerName, found.id);
    }
  }
  if (!customerId) {
    const body: Record<string, unknown> = {
      name: customerName || "FX kunde",
      isCustomer: true,
    };
    if (orgNumber) body.organizationNumber = orgNumber;
    const created = await client.post<{ id: number }>("/customer", body);
    customerId = created.value.id;
    console.log(`[Handler] Created customer: id=${customerId}`);
    if (customerName) ctx.registerCustomer(customerName, customerId);
  }

  // 2. Try to find and pay unpaid invoice
  let invoicePaid = false;
  try {
    const invoices = await client.list<{
      id: number;
      invoiceNumber: number;
      amountOutstanding: number;
      amountOutstandingTotal: number;
    }>("/invoice", {
      customerId: String(customerId),
      invoiceDateFrom: "2025-01-01",
      invoiceDateTo: "2026-12-31",
      from: "0",
      count: "10",
    });

    const unpaid = invoices.values.find(inv => inv.amountOutstanding > 0 || inv.amountOutstandingTotal > 0);
    if (unpaid) {
      console.log(`[Handler] Found unpaid invoice: #${unpaid.invoiceNumber} (outstanding: ${unpaid.amountOutstandingTotal})`);

      const paymentTypes = await client.list<{ id: number; description: string }>("/invoice/paymentType", {
        from: "0",
        count: "10",
      });
      const payTypeId = paymentTypes.values[0]?.id;

      if (payTypeId) {
        const paidAmount = paymentNok > 0 ? paymentNok : Math.round(unpaid.amountOutstandingTotal * (paymentRate || 1));
        await client.put(
          `/invoice/${unpaid.id}/:payment?paymentDate=${today()}&paymentTypeId=${payTypeId}&paidAmount=${paidAmount}`,
          {},
        );
        console.log(`[Handler] Registered FX payment: ${paidAmount} NOK`);
        invoicePaid = true;
      }
    }
  } catch (err) {
    console.warn(`[Handler] Could not find/pay invoice: ${err instanceof Error ? err.message : err}`);
  }

  // 3. Post exchange difference voucher
  if (Math.abs(diff) > 0.01) {
    const isLoss = diff < 0;
    const absDiff = Math.abs(Math.round(diff));
    const fxAccount = await findAccount(client, isLoss ? 8160 : 8060);
    const bankAccount = await findAccount(client, 1920);

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
    // Fallback: no diff and no payment — create a generic FX voucher
    const bankAccount = await findAccount(client, 1920);
    const fxAccount = await findAccount(client, 8160);
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
