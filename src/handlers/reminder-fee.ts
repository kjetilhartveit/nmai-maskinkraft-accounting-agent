import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  today,
  findCustomerByName,
  ensureBankAccountConfigured,
  findOrCreateProduct,
} from "../lib/tripletex-helpers.js";

function parseNum(v: unknown, fallback: number): number {
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.,\-]/g, "").replace(",", "."));
    if (!isNaN(n) && n > 0) return n;
  }
  return fallback;
}

interface Invoice {
  id: number;
  invoiceNumber: number;
  amount: number;
  amountOutstanding: number;
  customer: { id: number; name: string };
  comment?: string;
}

interface PaymentType {
  id: number;
  description: string;
}

/**
 * Reminder fee handler.
 *
 * 1. Find overdue invoice
 * 2. Post reminder fee voucher (debit 1500, credit 3400)
 * 3. Create & send reminder fee invoice
 * 4. Register partial payment on overdue invoice
 */
export async function handleReminderFee(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const customerName = String(entity.customerName ?? entity.customer ?? "").replace(/^null$/i, "");
  const orgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
  const reminderFeeAmount = parseNum(entity.reminderFeeAmount ?? entity.feeAmount ?? entity.amount, 70);
  const partialPaymentAmount = parseNum(entity.partialPaymentAmount ?? entity.paymentAmount, 0);
  const debitAccountNumber = parseNum(entity.debitAccount ?? entity.debitAccountNumber, 1500);
  const creditAccountNumber = parseNum(entity.creditAccount ?? entity.creditAccountNumber, 3400);

  await ensureBankAccountConfigured(client);

  // 1. Find or create customer
  let customerId: number | undefined;
  if (customerName) {
    customerId = ctx.getCustomerId(customerName);
    if (!customerId) {
      const existing = await findCustomerByName(client, customerName);
      if (existing) customerId = existing.id;
    }
  }

  if (!customerId && orgNumber) {
    const byOrg = await client.list<{ id: number }>("/customer", {
      organizationNumber: orgNumber,
      from: "0",
      count: "1",
    });
    if (byOrg.values.length > 0) customerId = byOrg.values[0].id;
  }

  // Find customer with overdue invoices if no specific customer given
  if (!customerId) {
    const allInvoices = await client.list<Invoice>("/invoice", {
      invoiceDateFrom: "2020-01-01",
      invoiceDateTo: "2030-12-31",
      from: "0",
      count: "50",
    });
    const overdueInv = allInvoices.values.find((inv) => inv.amountOutstanding > 0);
    if (overdueInv) {
      customerId = overdueInv.customer.id;
      console.log(`[Handler] Found overdue invoice #${overdueInv.invoiceNumber} for customer ${overdueInv.customer.name}`);
    }
  }

  if (!customerId) {
    const body: Record<string, unknown> = { name: customerName || "Ukjent kunde", isCustomer: true };
    if (orgNumber) body.organizationNumber = orgNumber;
    const created = await client.post<{ id: number }>("/customer", body);
    customerId = created.value.id;
    if (customerName) ctx.registerCustomer(customerName, customerId);
  }

  // 2. Find overdue invoice
  const invoices = await client.list<Invoice>("/invoice", {
    customerId: String(customerId),
    invoiceDateFrom: "2020-01-01",
    invoiceDateTo: "2030-12-31",
    from: "0",
    count: "20",
  });

  const overdueInvoice = invoices.values.find((inv) => inv.amountOutstanding > 0)
    ?? invoices.values[0]
    ?? null;

  // 3. Post reminder fee voucher (debit 1500 accounts receivable, credit 3400 reminder income)
  const [debitAcct, creditAcct] = await Promise.all([
    findAccountByNumber(client, debitAccountNumber),
    findAccountByNumber(client, creditAccountNumber),
  ]);

  const debitPosting: Record<string, unknown> = {
    row: 1,
    account: { id: debitAcct.id },
    date: today(),
    amountGross: reminderFeeAmount,
    amountGrossCurrency: reminderFeeAmount,
    description: "Purregebyr",
  };
  if (debitAccountNumber === 1500 && customerId) {
    debitPosting.customer = { id: customerId };
  }

  await client.post("/ledger/voucher", {
    date: today(),
    description: overdueInvoice
      ? `Purregebyr for faktura ${overdueInvoice.invoiceNumber}`
      : "Purregebyr",
    postings: [
      debitPosting,
      { row: 2, account: { id: creditAcct.id }, date: today(), amountGross: -reminderFeeAmount, amountGrossCurrency: -reminderFeeAmount, description: "Purregebyr inntekt" },
    ],
  });
  console.log(`[Handler] Posted reminder fee voucher: ${reminderFeeAmount} NOK (debit ${debitAccountNumber}, credit ${creditAccountNumber})`);

  // 4. Create reminder fee invoice and send it
  const product = await findOrCreateProduct(client, "Purregebyr", reminderFeeAmount);

  const order = await client.post<{ id: number }>("/order", {
    customer: { id: customerId },
    orderDate: today(),
    deliveryDate: today(),
  });

  await client.post("/order/orderline", {
    order: { id: order.value.id },
    product: { id: product.id },
    count: 1,
    unitPriceExcludingVatCurrency: reminderFeeAmount,
  });

  const inv = await client.post<{ id: number }>("/invoice", {
    invoiceDate: today(),
    invoiceDueDate: today(),
    orders: [{ id: order.value.id }],
    comment: overdueInvoice ? `Purregebyr for faktura ${overdueInvoice.invoiceNumber}` : "Purregebyr",
  });
  console.log(`[Handler] Created reminder fee invoice: id=${inv.value.id}`);

  // Send the reminder fee invoice
  try {
    const qs = new URLSearchParams({ sendType: "EMAIL", overrideEmailAddress: "faktura@example.no" });
    await client.put(`/invoice/${inv.value.id}/:send?${qs.toString()}`, {});
    console.log(`[Handler] Sent reminder fee invoice: id=${inv.value.id}`);
  } catch (err) {
    console.warn(`[Handler] Could not send reminder fee invoice: ${err instanceof Error ? err.message : err}`);
  }

  // 5. Register partial payment on the overdue invoice
  if (partialPaymentAmount > 0 && overdueInvoice) {
    const paymentTypes = await client.list<PaymentType>("/invoice/paymentType", {
      from: "0",
      count: "5",
    });
    const paymentTypeId = paymentTypes.values[0]?.id;
    if (paymentTypeId) {
      const qs = new URLSearchParams({
        paymentDate: today(),
        paymentTypeId: String(paymentTypeId),
        paidAmount: String(partialPaymentAmount),
      });
      await client.put(`/invoice/${overdueInvoice.id}/:payment?${qs.toString()}`, undefined);
      console.log(`[Handler] Registered partial payment of ${partialPaymentAmount} on invoice ${overdueInvoice.id}`);
    }
  }
}

async function findAccountByNumber(
  client: TripletexClient,
  accountNumber: number,
): Promise<{ id: number; number: number }> {
  const result = await client.list<{ id: number; number: number }>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  const account = result.values[0];
  if (!account) throw new Error(`Ledger account ${accountNumber} not found`);
  return account;
}
