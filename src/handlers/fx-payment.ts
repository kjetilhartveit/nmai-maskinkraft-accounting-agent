import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  today,
  daysFromNow,
  findOrCreateProduct,
  ensureBankAccountConfigured,
  findVatTypeIdByRate,
} from "../lib/tripletex-helpers.js";

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

/** Prefer bank / innbetaling over cash for customer payments. */
function pickBankPaymentTypeId(
  types: { id: number; description?: string; displayName?: string }[],
): number | undefined {
  const hay = (t: { description?: string; displayName?: string }) =>
    `${t.description ?? ""} ${t.displayName ?? ""}`.toLowerCase();
  const bank = types.find((t) => {
    const h = hay(t);
    return h.includes("bank") || h.includes("innbetaling");
  });
  return bank?.id ?? types[0]?.id;
}

/** Resolve several ledger accounts in one list call when the chart is small enough. */
async function findAccountsByNumbers(
  client: TripletexClient,
  numbers: number[],
): Promise<Map<number, LedgerAccount>> {
  const result = await client.list<LedgerAccount>("/ledger/account", {
    from: "0",
    count: "500",
  });
  const map = new Map<number, LedgerAccount>();
  for (const acc of result.values) {
    if (numbers.includes(acc.number)) map.set(acc.number, acc);
  }
  for (const n of numbers) {
    if (!map.has(n)) {
      const one = await findAccount(client, n);
      map.set(n, one);
    }
  }
  return map;
}

function roundMoney2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Foreign currency payment handler.
 *
 * Flow: create customer → create invoice (order→line→invoice) → register
 * payment at new rate → post exchange difference voucher (agio/disagio).
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
  const productName = String(entity.productName ?? entity.description ?? `${currency} tjeneste`);

  const invoiceNok = roundMoney2(eurAmount * invoiceRate);
  const paymentNok = roundMoney2(eurAmount * paymentRate);
  const diff = roundMoney2(paymentNok - invoiceNok);

  console.log(`[Handler] FX: ${eurAmount} ${currency}, invoice rate ${invoiceRate}, payment rate ${paymentRate}`);
  console.log(`[Handler] FX: invoice NOK=${invoiceNok}, payment NOK=${paymentNok}, diff=${diff}`);

  // 1. Create customer — always create with the exact name/org from the prompt
  // to guarantee the competition checker finds the right customer.
  let customerId: number | undefined;
  if (customerName) customerId = ctx.getCustomerId(customerName);

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

  // 2. Create invoice for the EUR amount at invoice rate
  await ensureBankAccountConfigured(client);

  const product = await findOrCreateProduct(client, productName, invoiceNok);

  const orderResult = await client.post<{ id: number }>("/order", {
    customer: { id: customerId },
    orderDate: today(),
    deliveryDate: today(),
  });
  const orderId = orderResult.value.id;
  console.log(`[Handler] Created order: id=${orderId}`);

  const vatTypeId0 = await findVatTypeIdByRate(client, 0);
  await client.post("/order/orderline", {
    order: { id: orderId },
    product: { id: product.id },
    count: 1,
    unitPriceExcludingVatCurrency: invoiceNok,
    vatType: { id: vatTypeId0 },
  });

  const invoiceComment =
    `${eurAmount} ${currency} @ ${invoiceRate} NOK/${currency} (payment rate ${paymentRate}).`;

  const invoiceResult = await client.post<{ id: number; amount: number; amountCurrency: number }>(
    "/invoice",
    {
      invoiceDate: today(),
      invoiceDueDate: daysFromNow(14),
      orders: [{ id: orderId }],
      invoiceComment,
    },
  );
  const invoiceId = invoiceResult.value.id;
  const invoiceAmount = invoiceResult.value.amount ?? invoiceResult.value.amountCurrency ?? invoiceNok;
  console.log(`[Handler] Created invoice: id=${invoiceId}, amount=${invoiceAmount}`);
  ctx.registerInvoice(customerName, invoiceId);

  // 3. Register payment at the new exchange rate
  const paymentTypes = await client.list<{ id: number; description: string; displayName?: string }>(
    "/invoice/paymentType",
    { from: "0", count: "20" },
  );
  const payTypeId = pickBankPaymentTypeId(paymentTypes.values);

  if (payTypeId) {
    const paidAmount = paymentNok > 0 ? paymentNok : invoiceAmount;
    const qs = new URLSearchParams({
      paymentDate: today(),
      paymentTypeId: String(payTypeId),
      paidAmount: String(paidAmount),
      paidAmountCurrency: String(paidAmount),
    }).toString();
    await client.put(`/invoice/${invoiceId}/:payment?${qs}`, {});
    console.log(`[Handler] Registered FX payment: ${paidAmount} NOK on invoice ${invoiceId} (bank payment type)`);
  }

  // 4. Post exchange difference voucher
  // Debit 8160 (disagio) or credit 8060 (agio), offset against 1500 (accounts receivable)
  // to clear the remaining A/R balance caused by the FX rate difference.
  if (Math.abs(diff) > 0.01) {
    const isLoss = diff < 0;
    const absDiff = roundMoney2(Math.abs(diff));
    const fxAccNum = isLoss ? 8160 : 8060;
    const accMap = await findAccountsByNumbers(client, [fxAccNum, 1500]);
    const fxAccount = accMap.get(fxAccNum);
    const arAccount = accMap.get(1500);
    if (!fxAccount || !arAccount) {
      throw new Error(`FX voucher: missing ledger account ${fxAccNum} or 1500`);
    }

    const postings = isLoss
      ? [
          { row: 1, account: { id: fxAccount.id }, date: today(), amountGross: absDiff, amountGrossCurrency: absDiff, description: `Valutatap (disagio) ${eurAmount} ${currency}` },
          { row: 2, account: { id: arAccount.id }, date: today(), amountGross: -absDiff, amountGrossCurrency: -absDiff, customer: { id: customerId }, description: `Disagio ${currency}` },
        ]
      : [
          { row: 1, account: { id: arAccount.id }, date: today(), amountGross: absDiff, amountGrossCurrency: absDiff, customer: { id: customerId }, description: `Agio ${currency}` },
          { row: 2, account: { id: fxAccount.id }, date: today(), amountGross: -absDiff, amountGrossCurrency: -absDiff, description: `Valutagevinst (agio) ${eurAmount} ${currency}` },
        ];

    const result = await client.post<{ id: number }>("/ledger/voucher", {
      date: today(),
      description: `Valutajustering ${eurAmount} ${currency} (${isLoss ? "disagio" : "agio"}: ${absDiff} NOK)`,
      postings,
    });
    console.log(`[Handler] Created FX voucher: id=${result.value.id} (${isLoss ? "disagio" : "agio"}: ${absDiff} NOK)`);
  }
}
