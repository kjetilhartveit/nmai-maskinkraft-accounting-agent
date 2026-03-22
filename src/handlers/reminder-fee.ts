import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  today,
  findOrCreateProduct,
  findVatTypeIdByRate,
  ensureBankAccountConfigured,
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
  invoiceDate: string;
  invoiceDueDate: string;
  amount: number;
  amountOutstanding: number;
  isCharged: boolean;
  isCredited: boolean;
  isCreditNote: boolean;
  customer: { id: number; name?: string };
}

interface PaymentType {
  id: number;
  description: string;
}

/**
 * Reminder fee handler.
 *
 * 1. Find the overdue invoice (due date in the past + outstanding balance)
 * 2. Post reminder fee voucher (debit 1500, credit 3400)
 * 3. Create & send reminder fee invoice (VAT-exempt)
 * 4. Register partial payment on overdue invoice
 */
export async function handleReminderFee(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const reminderFeeAmount = parseNum(entity.reminderFeeAmount ?? entity.feeAmount ?? entity.amount, 50);
  const partialPaymentAmount = parseNum(entity.partialPaymentAmount ?? entity.paymentAmount, 0);
  const debitAccountNumber = parseNum(entity.debitAccount ?? entity.debitAccountNumber, 1500);
  const creditAccountNumber = parseNum(entity.creditAccount ?? entity.creditAccountNumber, 3400);
  const todayDate = today();

  // 1. Find overdue invoice — must have outstanding balance AND due date in the past
  const [allInvoices] = await Promise.all([
    client.list<Invoice>("/invoice", {
      invoiceDateFrom: "2000-01-01",
      invoiceDateTo: todayDate,
      from: "0",
      count: "100",
    }),
    ensureBankAccountConfigured(client),
  ]);

  const candidates = allInvoices.values.filter(
    (inv) => inv.amountOutstanding > 0 && !inv.isCredited && !inv.isCreditNote,
  );

  // Prefer strictly overdue (due date before today)
  let overdueInvoice = candidates.find(
    (inv) => inv.invoiceDueDate < todayDate,
  );

  // Fallback: due date is today or earlier
  if (!overdueInvoice) {
    overdueInvoice = candidates.find(
      (inv) => inv.invoiceDueDate <= todayDate,
    );
  }

  // Last resort: any outstanding invoice
  if (!overdueInvoice) {
    overdueInvoice = candidates[0];
  }

  if (!overdueInvoice) {
    throw new Error("No overdue invoice found");
  }

  const customerId = overdueInvoice.customer.id;
  console.log(
    `[Handler] Overdue invoice #${overdueInvoice.invoiceNumber} (id=${overdueInvoice.id}), ` +
    `due=${overdueInvoice.invoiceDueDate}, outstanding=${overdueInvoice.amountOutstanding}, ` +
    `customer=${customerId}`,
  );

  // 2. Get accounts + VAT type in parallel
  const [debitAcct, creditAcct, vatExemptId] = await Promise.all([
    findAccountByNumber(client, debitAccountNumber),
    findAccountByNumber(client, creditAccountNumber),
    findVatTypeIdByRate(client, 0),
  ]);

  // 3. Post reminder fee voucher (debit accounts receivable, credit reminder income)
  const debitPosting: Record<string, unknown> = {
    row: 1,
    account: { id: debitAcct.id },
    date: todayDate,
    amountGross: reminderFeeAmount,
    amountGrossCurrency: reminderFeeAmount,
    description: "Purregebyr",
  };
  if (debitAccountNumber === 1500) {
    debitPosting.customer = { id: customerId };
  }

  await client.post("/ledger/voucher", {
    date: todayDate,
    description: `Purregebyr faktura ${overdueInvoice.invoiceNumber}`,
    postings: [
      debitPosting,
      {
        row: 2,
        account: { id: creditAcct.id },
        date: todayDate,
        amountGross: -reminderFeeAmount,
        amountGrossCurrency: -reminderFeeAmount,
        description: "Purregebyr",
      },
    ],
  });
  console.log(`[Handler] Posted reminder fee voucher: ${reminderFeeAmount} NOK`);

  // 4. Create reminder fee invoice — reminder fees are VAT-exempt in Norway
  // Reuse any existing product (override price/VAT on the orderline);
  // only create "Purregebyr" product if the sandbox has none at all
  const existingProducts = await client.list<{ id: number }>("/product", { from: "0", count: "1" });
  let productId: number;
  if (existingProducts.values.length > 0) {
    productId = existingProducts.values[0].id;
  } else {
    const created = await findOrCreateProduct(client, "Purregebyr", reminderFeeAmount, vatExemptId);
    productId = created.id;
  }

  const order = await client.post<{ id: number }>("/order", {
    customer: { id: customerId },
    orderDate: todayDate,
    deliveryDate: todayDate,
  });

  await client.post("/order/orderline", {
    order: { id: order.value.id },
    product: { id: productId },
    count: 1,
    unitPriceExcludingVatCurrency: reminderFeeAmount,
    vatType: { id: vatExemptId },
  });

  const inv = await client.post<{ id: number }>("/invoice", {
    invoiceDate: todayDate,
    invoiceDueDate: todayDate,
    orders: [{ id: order.value.id }],
  });
  console.log(`[Handler] Created reminder fee invoice id=${inv.value.id}`);

  // Send the reminder fee invoice
  try {
    const qs = new URLSearchParams({ sendType: "EMAIL", overrideEmailAddress: "faktura@example.no" });
    await client.put(`/invoice/${inv.value.id}/:send?${qs.toString()}`, {});
    console.log(`[Handler] Sent reminder fee invoice`);
  } catch (err) {
    console.warn(`[Handler] Could not send reminder fee invoice: ${err instanceof Error ? err.message : err}`);
  }

  // 5. Register partial payment on the overdue invoice
  if (partialPaymentAmount > 0) {
    const paymentTypes = await client.list<PaymentType>("/invoice/paymentType", {
      from: "0",
      count: "5",
    });
    const paymentTypeId = paymentTypes.values[0]?.id;
    if (paymentTypeId) {
      const qs = new URLSearchParams({
        paymentDate: todayDate,
        paymentTypeId: String(paymentTypeId),
        paidAmount: String(partialPaymentAmount),
      });
      await client.put(`/invoice/${overdueInvoice.id}/:payment?${qs.toString()}`, undefined);
      console.log(`[Handler] Registered partial payment of ${partialPaymentAmount} on invoice #${overdueInvoice.invoiceNumber}`);
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
