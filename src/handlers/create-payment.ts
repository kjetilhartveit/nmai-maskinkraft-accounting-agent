import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, findCustomerByName, ensureBankAccountConfigured } from "../lib/tripletex-helpers.js";

interface Invoice {
  id: number;
  invoiceNumber: number;
  amount: number;
  amountCurrency: number;
  amountExcludingVat: number;
  amountOutstanding: number;
  amountCurrencyOutstanding: number;
  customer: { id: number; name: string };
}

interface PaymentType {
  id: number;
  description: string;
}

async function findInvoiceForPayment(
  client: TripletexClient,
  customerName?: string,
  amount?: number,
): Promise<Invoice | null> {
  const params: Record<string, string> = {
    invoiceDateFrom: "2020-01-01",
    invoiceDateTo: "2030-12-31",
    from: "0",
    count: "100",
  };

  const result = await client.list<Invoice>("/invoice", params);

  if (result.values.length === 0) return null;

  // Try to match by customer name and/or amount
  const candidates = result.values.filter((inv) => {
    if (customerName) {
      const name = inv.customer?.name?.toLowerCase() ?? "";
      if (!name.includes(customerName.toLowerCase())) return false;
    }
    if (amount) {
      const matches =
        Math.abs(inv.amount - amount) < 1 ||
        Math.abs(inv.amountExcludingVat - amount) < 1 ||
        Math.abs(inv.amountCurrency - amount) < 1;
      if (!matches) return false;
    }
    return true;
  });

  if (candidates.length > 0) return candidates[0];

  // Fallback: return the first invoice with an outstanding balance
  const unpaid = result.values.filter(
    (inv) => inv.amountOutstanding > 0 || inv.amountCurrencyOutstanding > 0,
  );
  return unpaid[0] ?? result.values[0];
}

let cachedPaymentTypeId: number | null = null;

async function getPaymentTypeId(client: TripletexClient): Promise<number> {
  if (cachedPaymentTypeId) return cachedPaymentTypeId;
  const result = await client.list<PaymentType>("/invoice/paymentType", {
    from: "0",
    count: "20",
  });
  if (result.values.length > 0) {
    cachedPaymentTypeId = result.values[0].id;
    return cachedPaymentTypeId;
  }
  throw new Error("No payment types available");
}

export function resetPaymentCache(): void {
  cachedPaymentTypeId = null;
}

export async function handleCreatePayment(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const customerName = String(entity.customerName ?? entity.customer ?? "");
  const rawAmount = Number(entity.amount ?? entity.paidAmount ?? 0);
  const paymentDate = String(entity.paymentDate ?? entity.date ?? today());

  await ensureBankAccountConfigured(client);

  console.log(
    `[Handler] Searching for invoice — customer: "${customerName}", amount: ${rawAmount}`,
  );

  let invoice = await findInvoiceForPayment(
    client,
    customerName || undefined,
    rawAmount || undefined,
  );

  if (!invoice) {
    // If no invoice found, we might need to create the whole chain
    console.log("[Handler] No existing invoice found — creating invoice chain");

    let customerId: number;
    if (customerName) {
      const ctxId = ctx.getCustomerId(customerName);
      if (ctxId) {
        console.log(`[Handler] Using customer from context: ${customerName} → id=${ctxId}`);
        customerId = ctxId;
      } else {
        const existing = await findCustomerByName(client, customerName);
        if (existing) {
          customerId = existing.id;
        } else {
          const orgNumber = String(entity.organizationNumber ?? entity.orgNumber ?? "");
          const body: Record<string, unknown> = {
            name: customerName,
            isCustomer: true,
          };
          if (orgNumber) body.organizationNumber = orgNumber;
          const created = await client.post<{ id: number }>("/customer", body);
          customerId = created.value.id;
          ctx.registerCustomer(customerName, customerId);
        }
      }
    } else {
      throw new Error("Cannot create invoice chain: no customer name provided");
    }

    const amount = rawAmount || 10000;
    const description = String(
      entity.productName ?? entity.description ?? entity.service ?? "Service",
    );

    const order = await client.post<{ id: number }>("/order", {
      customer: { id: customerId },
      orderDate: today(),
      deliveryDate: today(),
    });

    await client.post("/order/orderline", {
      order: { id: order.value.id },
      description,
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
    console.log(`[Handler] Created invoice: id=${invoice.id}`);
  }

  // Get payment type
  const paymentTypeId = await getPaymentTypeId(client);

  // For full payment, use the invoice's outstanding amount (includes VAT)
  // The prompt amount is typically ex-VAT, but we need to pay the full balance
  const paidAmount =
    invoice.amountOutstanding ||
    invoice.amountCurrencyOutstanding ||
    invoice.amount ||
    invoice.amountCurrency ||
    rawAmount;

  console.log(
    `[Handler] Registering payment: invoice=${invoice.id}, amount=${paidAmount}, date=${paymentDate}, paymentType=${paymentTypeId}`,
  );

  // PUT /invoice/{id}/:payment with query params
  const qs = new URLSearchParams({
    paymentDate,
    paymentTypeId: String(paymentTypeId),
    paidAmount: String(paidAmount),
  }).toString();

  await client.put<unknown>(`/invoice/${invoice.id}/:payment?${qs}`, undefined);
  console.log(`[Handler] Payment registered successfully on invoice ${invoice.id}`);
}
