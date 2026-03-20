import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import {
  today,
  daysFromNow,
  findCustomerByName,
  findOrCreateProduct,
} from "../lib/tripletex-helpers.js";

interface Order {
  id: number;
}

interface Customer {
  id: number;
  name: string;
}

async function findOrderByCustomerName(
  client: TripletexClient,
  customerName: string,
): Promise<Order | null> {
  // Order endpoint requires date range - search last 2 years
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

async function createOrderForInvoice(
  client: TripletexClient,
  customerId: number,
  productName: string,
  amount: number,
): Promise<Order> {
  const orderDate = today();
  const deliveryDate = daysFromNow(14);

  // Create order
  const orderResult = await client.post<Order>("/order", {
    customer: { id: customerId },
    orderDate,
    deliveryDate,
  });
  const orderId = orderResult.value.id;
  console.log(`[Handler] Created order for invoice: id=${orderId}`);

  // Create product and add order line
  const product = await findOrCreateProduct(client, productName, amount);
  await client.post("/order/orderline", {
    order: { id: orderId },
    product: { id: product.id },
    count: 1,
    unitPriceExcludingVatCurrency: amount,
  });
  console.log(`[Handler] Added order line with product ${product.id}`);

  return orderResult.value;
}

export async function handleCreateInvoice(
  client: TripletexClient,
  task: ParsedTask,
  sendAfterCreate = false,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const invoiceDate = String(entity.invoiceDate ?? entity.date ?? today());
  const invoiceDueDate = String(
    entity.dueDate ?? entity.invoiceDueDate ?? daysFromNow(14),
  );

  const customerName = String(
    entity.customerName ?? entity.customer ?? "",
  );

  // Resolve order
  let order: Order | null = null;
  if (entity.orderId) {
    order = await findOrderById(client, Number(entity.orderId));
  }
  if (!order && customerName) {
    order = await findOrderByCustomerName(client, customerName);
  }

  // If no order exists, create one with the customer and product/amount
  if (!order && customerName) {
    const customer = await findCustomerByName(client, customerName);
    if (customer) {
      // Extract product name and amount from entity
      const productName = String(
        entity.productName ?? entity.product ?? entity.description ?? "Tjeneste",
      );
      const amount = Number(entity.amount ?? entity.total ?? entity.unitPrice ?? 0);

      if (amount > 0) {
        order = await createOrderForInvoice(
          client,
          customer.id,
          productName,
          amount,
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
    await client.put(`/invoice/${invoiceId}/:send`, {
      sendType: "EMAIL",
    });
    console.log(`[Handler] Sent invoice: id=${invoiceId}`);
  }
}

export async function handleSendInvoice(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  return handleCreateInvoice(client, task, true);
}
