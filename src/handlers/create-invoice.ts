import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import { today, daysFromNow } from "../lib/tripletex-helpers.js";

interface Order {
  id: number;
}

async function findOrderByCustomerName(
  client: TripletexClient,
  customerName: string,
): Promise<Order | null> {
  const result = await client.list<Order>("/order", {
    customerName,
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

  // Resolve order
  let order: Order | null = null;
  if (entity.orderId) {
    order = await findOrderById(client, Number(entity.orderId));
  }
  if (!order && entity.customerName) {
    order = await findOrderByCustomerName(
      client,
      String(entity.customerName ?? entity.customer ?? ""),
    );
  }

  if (!order) {
    console.warn("[Handler] No order found for invoice");
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
