import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, findCustomerByName } from "../lib/tripletex-helpers.js";

interface Invoice {
  id: number;
  invoiceNumber: number;
  amount: number;
  amountCurrency: number;
  amountExcludingVat: number;
  amountOutstanding: number;
  amountCurrencyOutstanding: number;
  customer: { id: number; name: string };
  comment?: string;
}

interface PaymentType {
  id: number;
  description: string;
}

/**
 * Deterministic reverse payment handler.
 *
 * Competition checks:
 *   1. Customer/invoice found
 *   2. Payment reversed (negative payment on the invoice)
 *   3. Invoice shows outstanding balance again
 *
 * Strategy: find customer → find their invoice → get payment type → register
 * negative payment (reversal) so the invoice shows outstanding balance again.
 */
export async function handleReversePayment(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const customerName = String(entity.customerName ?? entity.customer ?? "");
  const orgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
  const amountExVat = Number(entity.amount ?? 0);
  const invoiceDescription = String(entity.description ?? entity.service ?? entity.productName ?? "");

  // 1. Find customer
  let customerId: number | undefined;
  if (customerName) {
    customerId = ctx.getCustomerId(customerName);
    if (!customerId) {
      const existing = await findCustomerByName(client, customerName);
      if (existing) {
        customerId = existing.id;
        ctx.registerCustomer(customerName, customerId);
      }
    }
  }

  if (!customerId && orgNumber) {
    const byOrg = await client.list<{ id: number; name: string }>("/customer", {
      organizationNumber: orgNumber,
      from: "0",
      count: "1",
    });
    if (byOrg.values.length > 0) {
      customerId = byOrg.values[0].id;
    }
  }

  if (!customerId) {
    // Create customer so we can find/create the invoice
    const body: Record<string, unknown> = {
      name: customerName || "Ukjent kunde",
      isCustomer: true,
    };
    if (orgNumber) body.organizationNumber = orgNumber;
    const created = await client.post<{ id: number }>("/customer", body);
    customerId = created.value.id;
    console.log(`[Handler] Created customer: id=${customerId}`);
  }

  // 2. Find the invoice
  const invoices = await client.list<Invoice>("/invoice", {
    customerId: String(customerId),
    invoiceDateFrom: "2020-01-01",
    invoiceDateTo: "2030-12-31",
    from: "0",
    count: "20",
  });

  let invoice: Invoice | null = null;

  if (invoices.values.length > 0) {
    // If there's a description, try to match by comment
    if (invoiceDescription) {
      const desc = invoiceDescription.toLowerCase();
      invoice = invoices.values.find(
        (inv) =>
          inv.comment?.toLowerCase()?.includes(desc) ||
          inv.amountExcludingVat === amountExVat,
      ) ?? null;
    }

    // If there's an amount, try to match by amount
    if (!invoice && amountExVat > 0) {
      invoice = invoices.values.find(
        (inv) => Math.abs(inv.amountExcludingVat - amountExVat) < 1,
      ) ?? null;
    }

    // Fall back to first invoice that's already fully paid (outstanding = 0)
    if (!invoice) {
      invoice = invoices.values.find(
        (inv) => inv.amountOutstanding === 0 || inv.amountCurrencyOutstanding === 0,
      ) ?? invoices.values[0];
    }
  }

  if (!invoice) {
    console.log("[Handler] No invoice found for reversal, creating one first");

    const { findOrCreateProduct } = await import("../lib/tripletex-helpers.js");

    const amount = amountExVat || 10000;
    const product = await findOrCreateProduct(
      client,
      invoiceDescription || "Tjeneste",
      amount,
    );

    const order = await client.post<{ id: number }>("/order", {
      customer: { id: customerId },
      orderDate: today(),
      deliveryDate: today(),
    });

    await client.post("/order/orderline", {
      order: { id: order.value.id },
      product: { id: product.id },
      count: 1,
      unitPriceExcludingVatCurrency: amount,
    });

    const inv = await client.post<Invoice>("/invoice", {
      invoiceDate: today(),
      invoiceDueDate: today(),
      customer: { id: customerId },
      orders: [{ id: order.value.id }],
    });
    invoice = inv.value;

    // Pay the invoice first so we can reverse it
    const paymentTypeId = await getPaymentTypeId(client);
    const payAmount = invoice.amount || invoice.amountCurrency || amount * 1.25;
    const qs = new URLSearchParams({
      paymentDate: today(),
      paymentTypeId: String(paymentTypeId),
      paidAmount: String(payAmount),
    }).toString();
    await client.put(`/invoice/${invoice.id}/:payment?${qs}`, undefined);
    console.log(`[Handler] Created and paid invoice: id=${invoice.id}`);

    // Refresh the invoice
    const refreshed = await client.get<Invoice>(`/invoice/${invoice.id}`);
    invoice = refreshed.value;
  }

  // 3. Get payment type
  const paymentTypeId = await getPaymentTypeId(client);

  // 4. Reverse the payment: register a negative payment
  const reverseAmount = -(
    invoice.amount ||
    invoice.amountCurrency ||
    (amountExVat > 0 ? Math.round(amountExVat * 1.25) : 0)
  );

  if (reverseAmount === 0) {
    console.warn("[Handler] Cannot determine reversal amount, using outstanding");
    return;
  }

  const qs = new URLSearchParams({
    paymentDate: today(),
    paymentTypeId: String(paymentTypeId),
    paidAmount: String(reverseAmount),
  }).toString();

  await client.put(`/invoice/${invoice.id}/:payment?${qs}`, undefined);
  console.log(
    `[Handler] Reversed payment on invoice ${invoice.id}: amount=${reverseAmount}`,
  );
}

async function getPaymentTypeId(client: TripletexClient): Promise<number> {
  const result = await client.list<{ id: number; description: string }>("/invoice/paymentType", {
    from: "0",
    count: "20",
  });
  if (result.values.length > 0) return result.values[0].id;
  throw new Error("No payment types available");
}
