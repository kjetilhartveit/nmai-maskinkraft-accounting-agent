import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import {
  findCustomerByName,
  findOrCreateProduct,
  today,
  daysFromNow,
} from "../lib/tripletex-helpers.js";

interface ProductLine {
  name?: string;
  quantity?: number;
  count?: number;
  unitPrice?: number;
  price?: number;
}

export async function handleCreateOrder(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  // Resolve customer
  const customerName = String(
    entity.customerName ?? entity.customer ?? entity.name ?? "",
  );
  let customerId: number | null = null;
  if (customerName) {
    const customer = await findCustomerByName(client, customerName);
    if (customer) customerId = customer.id;
  }
  if (!customerId && entity.customerId) customerId = Number(entity.customerId);
  if (!customerId) {
    console.warn("[Handler] No customer found for order, cannot proceed");
    return;
  }

  const orderDate = String(entity.orderDate ?? entity.date ?? today());
  const deliveryDate = String(
    entity.deliveryDate ?? entity.dueDate ?? daysFromNow(14),
  );

  const orderBody: Record<string, unknown> = {
    customer: { id: customerId },
    orderDate,
    deliveryDate,
  };

  if (entity.ourReference) orderBody.ourReference = entity.ourReference;
  if (entity.yourReference) orderBody.yourReference = entity.yourReference;
  if (entity.comment) orderBody.orderComment = entity.comment;

  const orderResult = await client.post<{ id: number }>("/order", orderBody);
  const orderId = orderResult.value.id;
  console.log(`[Handler] Created order: id=${orderId}`);

  // Add order lines if products are specified
  const products: ProductLine[] = Array.isArray(entity.products)
    ? (entity.products as ProductLine[])
    : [];

  // Also check if individual entities describe products
  const productEntities = task.entities
    .slice(1)
    .filter((e) => e.name && (e.unitPrice ?? e.price));
  if (productEntities.length > 0) {
    for (const pe of productEntities) {
      products.push({
        name: String(pe.name ?? ""),
        quantity: Number(pe.quantity ?? pe.count ?? 1),
        unitPrice: Number(pe.unitPrice ?? pe.price ?? 0),
      });
    }
  }

  if (products.length > 0) {
    const orderLines = await Promise.all(
      products.map(async (p) => {
        const product = await findOrCreateProduct(
          client,
          String(p.name ?? "Produkt"),
          Number(p.unitPrice ?? p.price ?? 0),
        );
        return {
          order: { id: orderId },
          product: { id: product.id },
          count: Number(p.quantity ?? p.count ?? 1),
          unitPriceExcludingVatCurrency: Number(p.unitPrice ?? p.price ?? 0),
        };
      }),
    );

    if (orderLines.length === 1) {
      await client.post("/order/orderline", orderLines[0]);
    } else {
      await client.postList("/order/orderline/list", orderLines);
    }
    console.log(`[Handler] Added ${orderLines.length} order line(s) to order ${orderId}`);
  }
}
