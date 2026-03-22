import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, findCustomerByName, findOrCreateProduct, ensureBankAccountConfigured } from "../lib/tripletex-helpers.js";

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
    count: "20",
  };
  if (customerName) params.customerName = customerName;

  const result = await client.list<Invoice>("/invoice", params);

  if (result.values.length === 0 && customerName) {
    // Retry without customer filter in case name doesn't match exactly
    delete params.customerName;
    params.count = "50";
    const fallback = await client.list<Invoice>("/invoice", params);
    if (fallback.values.length === 0) return null;

    const byName = fallback.values.filter((inv) => {
      const name = inv.customer?.name?.toLowerCase() ?? "";
      return name.includes(customerName.toLowerCase());
    });
    if (byName.length > 0) return byName[0];
    const unpaid = fallback.values.filter(
      (inv) => inv.amountOutstanding > 0 || inv.amountCurrencyOutstanding > 0,
    );
    return unpaid[0] ?? fallback.values[0];
  }

  if (result.values.length === 0) return null;

  if (amount) {
    const byAmount = result.values.filter((inv) =>
      Math.abs(inv.amount - amount) < 1 ||
      Math.abs(inv.amountExcludingVat - amount) < 1 ||
      Math.abs(inv.amountCurrency - amount) < 1,
    );
    if (byAmount.length > 0) return byAmount[0];
  }

  const unpaid = result.values.filter(
    (inv) => inv.amountOutstanding > 0 || inv.amountCurrencyOutstanding > 0,
  );
  return unpaid[0] ?? result.values[0];
}

async function getPaymentTypeId(client: TripletexClient): Promise<number> {
  const result = await client.list<PaymentType>("/invoice/paymentType", {
    from: "0",
    count: "20",
  });
  if (result.values.length > 0) return result.values[0].id;
  throw new Error("No payment types available");
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

  // Check context for an invoice created by a prior task in this sequence
  let invoice: Invoice | null = null;
  const ctxInvoiceId = customerName ? ctx.getInvoiceId(customerName) : undefined;
  const fallbackInvoiceId = ctxInvoiceId ?? ctx.getLastInvoiceId();
  if (fallbackInvoiceId) {
    console.log(`[Handler] Using invoice from context: id=${fallbackInvoiceId}`);
    try {
      const inv = await client.get<Invoice>(`/invoice/${fallbackInvoiceId}`);
      invoice = inv.value;
    } catch {
      console.log(`[Handler] Context invoice ${fallbackInvoiceId} not found, falling back to search`);
    }
  }

  if (!invoice) {
    invoice = await findInvoiceForPayment(
      client,
      customerName || undefined,
      rawAmount || undefined,
    );
  }

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
      entity.productName ?? entity.description ?? entity.service ?? "Tjeneste",
    );

    const product = await findOrCreateProduct(client, description, amount);

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
