import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  today,
  daysFromNow,
  findCustomerByName,
  findOrCreateProduct,
  findVatTypeIdByRate,
  ensureBankAccountConfigured,
} from "../lib/tripletex-helpers.js";

interface Order {
  id: number;
}

interface Customer {
  id: number;
  name: string;
}

interface ProductLine {
  productName: string;
  unitPrice: number;
  quantity: number;
  vatRate?: number;
}

async function findOrderByCustomerName(
  client: TripletexClient,
  customerName: string,
): Promise<Order | null> {
  const now = new Date();
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(now.getFullYear() - 2);

  const result = await client.list<Order>("/order", {
    customerName,
    orderDateFrom: twoYearsAgo.toISOString().slice(0, 10),
    orderDateTo: now.toISOString().slice(0, 10),
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

async function findOrderById(
  client: TripletexClient,
  orderId: number,
): Promise<Order | null> {
  try {
    const result = await client.get<Order>(`/order/${orderId}`);
    return result.value;
  } catch {
    return null;
  }
}

function extractProductLines(task: ParsedTask): ProductLine[] {
  const entities = task.entities;
  if (entities.length === 0) return [];

  const first = entities[0];

  // Check if there's a productLines array in the first entity
  if (Array.isArray(first.productLines) && first.productLines.length > 0) {
    return (first.productLines as Record<string, unknown>[]).map((line) => ({
      productName: String(line.productName ?? line.name ?? line.description ?? "Produkt"),
      unitPrice: Number(line.unitPrice ?? line.amount ?? line.price ?? 0),
      quantity: Number(line.quantity ?? line.count ?? 1),
      vatRate: line.vatRate !== undefined ? Number(line.vatRate) : undefined,
    }));
  }

  // Check if additional entities (index 1+) are product lines
  if (entities.length > 1) {
    const hasProductEntities = entities.slice(1).some(
      (e) => e.productName || e.unitPrice || e.vatRate !== undefined,
    );

    if (hasProductEntities) {
      return entities.slice(1).map((e) => ({
        productName: String(e.productName ?? e.name ?? e.description ?? "Produkt"),
        unitPrice: Number(e.unitPrice ?? e.amount ?? e.price ?? 0),
        quantity: Number(e.quantity ?? e.count ?? 1),
        vatRate: e.vatRate !== undefined ? Number(e.vatRate) : undefined,
      }));
    }
  }

  // Single product line from the first entity (backward compatibility)
  const productName = String(
    first.productName ?? first.product ?? first.description ?? "Tjeneste",
  );
  const amount = Number(first.amount ?? first.total ?? first.unitPrice ?? 0);

  if (amount > 0) {
    return [{
      productName,
      unitPrice: amount,
      quantity: 1,
      vatRate: first.vatRate !== undefined ? Number(first.vatRate) : undefined,
    }];
  }

  return [];
}

async function createOrderForInvoice(
  client: TripletexClient,
  customerId: number,
  productLines: ProductLine[],
  ctx?: SequenceContext,
): Promise<Order> {
  const orderDate = today();
  const deliveryDate = daysFromNow(14);

  const orderResult = await client.post<Order>("/order", {
    customer: { id: customerId },
    orderDate,
    deliveryDate,
  });
  const orderId = orderResult.value.id;
  console.log(`[Handler] Created order for invoice: id=${orderId}`);

  for (const line of productLines) {
    let vatTypeId: number | undefined;
    if (line.vatRate !== undefined) {
      vatTypeId = await findVatTypeIdByRate(client, line.vatRate);
    }

    const cachedId = ctx?.getProductId(line.productName);
    let productId: number;
    if (cachedId) {
      console.log(`[Handler] Using product from context: ${line.productName} → id=${cachedId}`);
      productId = cachedId;
    } else {
      const product = await findOrCreateProduct(
        client,
        line.productName,
        line.unitPrice,
        vatTypeId,
      );
      productId = product.id;
    }

    await client.post("/order/orderline", {
      order: { id: orderId },
      product: { id: productId },
      count: line.quantity,
      unitPriceExcludingVatCurrency: line.unitPrice,
    });
    console.log(
      `[Handler] Added order line: ${line.productName} x${line.quantity} @ ${line.unitPrice}` +
        (line.vatRate !== undefined ? ` (VAT ${line.vatRate}%)` : ""),
    );
  }

  return orderResult.value;
}

export async function handleCreateInvoice(
  client: TripletexClient,
  task: ParsedTask,
  ctxOrSend?: SequenceContext | boolean,
  maybeSend?: boolean,
): Promise<void> {
  let ctx: SequenceContext | undefined;
  let sendAfterCreate = false;
  if (typeof ctxOrSend === "boolean") {
    sendAfterCreate = ctxOrSend;
  } else if (ctxOrSend) {
    ctx = ctxOrSend;
    sendAfterCreate = maybeSend ?? false;
  }

  await ensureBankAccountConfigured(client);

  const entity = task.entities[0] ?? {};

  const invoiceDate = String(entity.invoiceDate ?? entity.date ?? today());
  const invoiceDueDate = String(
    entity.dueDate ?? entity.invoiceDueDate ?? daysFromNow(14),
  );

  const customerName = String(
    entity.customerName ?? entity.customer ?? "",
  );

  let order: Order | null = null;
  if (entity.orderId) {
    order = await findOrderById(client, Number(entity.orderId));
  }
  if (!order && customerName) {
    order = await findOrderByCustomerName(client, customerName);
  }

  if (!order && customerName) {
    let customerId = ctx?.getCustomerId(customerName);
    let customer: Customer | null = null;
    if (customerId) {
      console.log(`[Handler] Using customer from context: ${customerName} → id=${customerId}`);
      customer = { id: customerId, name: customerName };
    } else {
      customer = await findCustomerByName(client, customerName);
    }

    if (customer) {
      const productLines = extractProductLines(task);

      if (productLines.length > 0) {
        order = await createOrderForInvoice(
          client,
          customer.id,
          productLines,
          ctx,
        );
      }
    }
  }

  if (!order) {
    console.warn("[Handler] No order found or could be created for invoice");
    return;
  }

  const invoiceBody: Record<string, unknown> = {
    invoiceDate,
    invoiceDueDate,
    orders: [{ id: order.id }],
  };

  if (entity.comment) invoiceBody.invoiceComment = entity.comment;

  const result = await client.post<{ id: number }>("/invoice", invoiceBody);
  const invoiceId = result.value.id;
  console.log(`[Handler] Created invoice: id=${invoiceId}`);

  if (sendAfterCreate) {
    await client.put(`/invoice/${invoiceId}/:send?sendType=EMAIL`, {});
    console.log(`[Handler] Sent invoice: id=${invoiceId}`);
  }
}

export async function handleSendInvoice(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  return handleCreateInvoice(client, task, ctx, true);
}
