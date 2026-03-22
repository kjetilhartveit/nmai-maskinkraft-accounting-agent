import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findCustomerByName,
  findOrCreateProduct,
  loadProductCatalog,
  findProductInCatalog,
  findProductInCatalogByNumber,
  findVatTypeIdByRate,
  today,
  daysFromNow,
} from "../lib/tripletex-helpers.js";

interface ProductLine {
  name?: string;
  productNumber?: string | number;
  quantity?: number;
  count?: number;
  unitPrice?: number;
  price?: number;
  vatRate?: number;
}

export async function handleCreateOrder(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  // Resolve customer — check context first
  const customerName = String(
    entity.customerName ?? entity.customer ?? entity.name ?? "",
  );
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
  ctx.registerOrder(customerName, orderId);

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
        productNumber: (pe.productNumber ?? pe.number) as string | number | undefined,
        quantity: Number(pe.quantity ?? pe.count ?? 1),
        unitPrice: Number(pe.unitPrice ?? pe.price ?? 0),
        vatRate: pe.vatRate !== undefined ? Number(pe.vatRate) : undefined,
      });
    }
  }

  if (products.length > 0) {
    // Batch load product catalog when ≥2 unresolved products
    const unresolvedCount = products.filter((p) => {
      const name = String(p.name ?? "Produkt");
      return !ctx.getProductId(name) && !(p.productNumber && ctx.getProductId(String(p.productNumber)));
    }).length;
    if (unresolvedCount >= 2) {
      await loadProductCatalog(client);
    }

    const orderLines: Record<string, unknown>[] = [];
    for (const p of products) {
      const productName = String(p.name ?? "Produkt");
      let productId = ctx.getProductId(productName) ??
        (p.productNumber ? ctx.getProductId(String(p.productNumber)) : undefined);

      if (productId) {
        console.log(`[Handler] Using product from context: ${productName} → id=${productId}`);
      } else {
        let found: { id: number } | null = null;

        if (p.productNumber) {
          found = findProductInCatalogByNumber(String(p.productNumber));
          if (found) {
            console.log(`[Handler] Found product by number ${p.productNumber}: id=${found.id}`);
          }
        }
        if (!found) {
          found = findProductInCatalog(productName);
          if (found) {
            console.log(`[Handler] Found product by name ${productName}: id=${found.id}`);
          }
        }

        if (found) {
          productId = found.id;
          ctx.registerProduct(productName, productId);
          if (p.productNumber) ctx.registerProduct(String(p.productNumber), productId);
        } else {
          const skipSearch = unresolvedCount >= 2;
          let vatTypeId: number | undefined;
          if (p.vatRate !== undefined) {
            vatTypeId = await findVatTypeIdByRate(client, p.vatRate);
          }
          const product = await findOrCreateProduct(
            client,
            productName,
            Number(p.unitPrice ?? p.price ?? 0),
            vatTypeId,
            skipSearch,
          );
          productId = product.id;
          ctx.registerProduct(productName, productId);
          if (p.productNumber) ctx.registerProduct(String(p.productNumber), productId);
        }
      }

      orderLines.push({
        order: { id: orderId },
        product: { id: productId },
        count: Number(p.quantity ?? p.count ?? 1),
        unitPriceExcludingVatCurrency: Number(p.unitPrice ?? p.price ?? 0),
      });
    }

    if (orderLines.length === 1) {
      await client.post("/order/orderline", orderLines[0]);
    } else {
      await client.postList("/order/orderline/list", orderLines);
    }
    console.log(`[Handler] Added ${orderLines.length} order line(s) to order ${orderId}`);
  }
}
