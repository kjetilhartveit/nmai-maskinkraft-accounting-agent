import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  today,
  findCustomerByName,
  findOrCreateProduct,
  ensureBankAccountConfigured,
} from "../lib/tripletex-helpers.js";

interface Invoice {
  id: number;
  invoiceNumber: number;
  amount: number;
  amountExcludingVat: number;
  customer: { id: number; name: string };
}

interface Order {
  id: number;
}

/**
 * Creates a credit note by:
 * 1. Finding or creating the customer
 * 2. Finding an existing invoice for that customer, OR creating one
 * 3. Calling PUT /invoice/{id}/:createCreditNote
 */
export async function handleCreateCreditNote(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  await ensureBankAccountConfigured(client);

  const customerName = String(
    entity.customerName ?? entity.customer ?? entity.name ?? "",
  );
  const amount = Number(entity.amount ?? entity.invoiceAmount ?? 0);
  const description = String(
    entity.productName ?? entity.description ?? entity.service ?? entity.comment ?? "Tjeneste",
  );

  // Resolve customer
  let customerId: number | null = null;
  if (customerName) {
    const ctxId = ctx.getCustomerId(customerName);
    if (ctxId) {
      console.log(`[Handler] Using customer from context: ${customerName} → id=${ctxId}`);
      customerId = ctxId;
    } else {
      const customer = await findCustomerByName(client, customerName);
      if (customer) customerId = customer.id;
    }
  }

  if (!customerId) {
    console.warn("[Handler] No customer found for credit note");
    return;
  }

  // Find an existing invoice for this customer to credit
  let invoiceId: number | null = null;
  const ctxInvoiceId = ctx.getInvoiceId(customerName);
  if (ctxInvoiceId) {
    invoiceId = ctxInvoiceId;
    console.log(`[Handler] Using invoice from context: id=${invoiceId}`);
  }

  if (!invoiceId) {
    const invoices = await client.list<Invoice>("/invoice", {
      customerName,
      invoiceDateFrom: "2020-01-01",
      invoiceDateTo: "2030-12-31",
      from: "0",
      count: "10",
    });

    // Prefer an invoice matching the amount (check both ex-VAT and total)
    const match = invoices.values.find((inv) => {
      if (amount <= 0) return true;
      return (
        Math.abs(inv.amountExcludingVat - amount) < 1 ||
        Math.abs(inv.amount - amount) < 1
      );
    });

    if (match) {
      invoiceId = match.id;
      console.log(`[Handler] Found existing invoice: id=${invoiceId}`);
    }
  }

  // If no existing invoice, create one so we can credit it
  if (!invoiceId) {
    console.log("[Handler] No existing invoice found, creating one to credit");

    const product = await findOrCreateProduct(client, description, amount || 10000);

    const order = await client.post<Order>("/order", {
      customer: { id: customerId },
      orderDate: today(),
      deliveryDate: today(),
    });

    await client.post("/order/orderline", {
      order: { id: order.value.id },
      product: { id: product.id },
      count: 1,
      unitPriceExcludingVatCurrency: amount || 10000,
    });

    const inv = await client.post<Invoice>("/invoice", {
      invoiceDate: today(),
      invoiceDueDate: today(),
      orders: [{ id: order.value.id }],
    });

    invoiceId = inv.value.id;
    console.log(`[Handler] Created invoice for crediting: id=${invoiceId}`);
  }

  // Create the credit note
  const creditDate = String(entity.date ?? today());
  const comment = String(entity.comment ?? entity.reason ?? "");
  const qs = new URLSearchParams({ date: creditDate });
  if (comment) qs.set("comment", comment);

  try {
    await client.put(`/invoice/${invoiceId}/:createCreditNote?${qs.toString()}`, undefined);
    console.log(`[Handler] Created credit note for invoice ${invoiceId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("kreditert") || msg.includes("credit")) {
      console.log(`[Handler] Invoice ${invoiceId} already has a credit note, skipping`);
    } else {
      throw err;
    }
  }
}
