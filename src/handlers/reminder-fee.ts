import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  today,
  findCustomerByName,
  ensureBankAccountConfigured,
  findOrCreateProduct,
} from "../lib/tripletex-helpers.js";

interface Invoice {
  id: number;
  invoiceNumber: number;
  amount: number;
  amountOutstanding: number;
  customer: { id: number; name: string };
  comment?: string;
}

/**
 * Reminder fee handler.
 *
 * Registers a reminder fee/charge on an overdue invoice.
 * Creates a new invoice for the reminder fee amount, linked to the customer.
 */
export async function handleReminderFee(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const customerName = String(entity.customerName ?? entity.customer ?? "");
  const orgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
  const reminderFeeAmount = Number(entity.reminderFeeAmount ?? entity.feeAmount ?? entity.amount ?? 70);
  const invoiceDescription = String(entity.invoiceDescription ?? entity.description ?? "");
  const invoiceAmount = Number(entity.invoiceAmount ?? 0);

  await ensureBankAccountConfigured(client);

  // 1. Find or create customer
  let customerId: number | undefined;
  if (customerName) {
    customerId = ctx.getCustomerId(customerName);
    if (!customerId) {
      const existing = await findCustomerByName(client, customerName);
      if (existing) {
        customerId = existing.id;
      }
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

  if (!customerId) {
    const body: Record<string, unknown> = {
      name: customerName || "Ukjent kunde",
      isCustomer: true,
    };
    if (orgNumber) body.organizationNumber = orgNumber;
    const created = await client.post<{ id: number }>("/customer", body);
    customerId = created.value.id;
    if (customerName) ctx.registerCustomer(customerName, customerId);
    console.log(`[Handler] Created customer: id=${customerId}`);
  }

  // 2. Find the overdue invoice (if it exists)
  const invoices = await client.list<Invoice>("/invoice", {
    customerId: String(customerId),
    invoiceDateFrom: "2020-01-01",
    invoiceDateTo: "2030-12-31",
    from: "0",
    count: "20",
  });

  let overdueInvoice: Invoice | null = null;
  if (invoices.values.length > 0) {
    // Prefer an invoice with outstanding balance
    overdueInvoice = invoices.values.find((inv) => inv.amountOutstanding > 0) ?? null;

    // If description matches, prefer that
    if (invoiceDescription && !overdueInvoice) {
      const desc = invoiceDescription.toLowerCase();
      overdueInvoice = invoices.values.find(
        (inv) => inv.comment?.toLowerCase()?.includes(desc),
      ) ?? null;
    }

    if (!overdueInvoice) {
      overdueInvoice = invoices.values[0];
    }
  }

  // 3. Create reminder fee invoice
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
    comment: overdueInvoice
      ? `Purregebyr for faktura ${overdueInvoice.invoiceNumber}`
      : "Purregebyr",
  });

  console.log(
    `[Handler] Created reminder fee invoice: id=${inv.value.id}, fee=${reminderFeeAmount} NOK` +
    (overdueInvoice ? `, for overdue invoice #${overdueInvoice.invoiceNumber}` : ""),
  );
}
