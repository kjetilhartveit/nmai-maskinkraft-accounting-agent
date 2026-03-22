import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  today,
  daysFromNow,
  findCustomerByName,
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

  const invoiceNok = eurAmount * invoiceRate;
  const paymentNok = eurAmount * paymentRate;
  const diff = paymentNok - invoiceNok;

  console.log(`[Handler] FX: ${eurAmount} ${currency}, invoice rate ${invoiceRate}, payment rate ${paymentRate}`);
  console.log(`[Handler] FX: invoice NOK=${invoiceNok}, payment NOK=${paymentNok}, diff=${diff}`);

  // 1. Create customer
  let customerId: number | undefined;
  if (customerName) customerId = ctx.getCustomerId(customerName);

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

  const invoiceResult = await client.post<{ id: number; amount: number; amountCurrency: number }>(
    "/invoice",
    {
      invoiceDate: today(),
      invoiceDueDate: daysFromNow(14),
      orders: [{ id: orderId }],
    },
  );
  const invoiceId = invoiceResult.value.id;
  const invoiceAmount = invoiceResult.value.amount ?? invoiceResult.value.amountCurrency ?? invoiceNok;
  console.log(`[Handler] Created invoice: id=${invoiceId}, amount=${invoiceAmount}`);
  ctx.registerInvoice(customerName, invoiceId);

  // 3. Register payment at the new exchange rate
  const paymentTypes = await client.list<{ id: number; description: string }>(
    "/invoice/paymentType",
    { from: "0", count: "10" },
  );
  const payTypeId = paymentTypes.values[0]?.id;

  if (payTypeId) {
    const paidAmount = paymentNok > 0 ? paymentNok : invoiceAmount;
    await client.put(
      `/invoice/${invoiceId}/:payment?paymentDate=${today()}&paymentTypeId=${payTypeId}&paidAmount=${paidAmount}`,
      {},
    );
    console.log(`[Handler] Registered FX payment: ${paidAmount} NOK on invoice ${invoiceId}`);
  }

  // 4. Post exchange difference voucher
  if (Math.abs(diff) > 0.01) {
    const isLoss = diff < 0;
    const absDiff = Math.abs(Math.round(diff));
    const [fxAccount, bankAccount] = await Promise.all([
      findAccount(client, isLoss ? 8160 : 8060),
      findAccount(client, 1920),
    ]);

    const postings = isLoss
      ? [
          { row: 1, account: { id: fxAccount.id }, date: today(), amountGross: absDiff, amountGrossCurrency: absDiff, description: `Valutatap (disagio) ${eurAmount} ${currency}` },
          { row: 2, account: { id: bankAccount.id }, date: today(), amountGross: -absDiff, amountGrossCurrency: -absDiff, description: `Disagio ${currency}` },
        ]
      : [
          { row: 1, account: { id: bankAccount.id }, date: today(), amountGross: absDiff, amountGrossCurrency: absDiff, description: `Agio ${currency}` },
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
