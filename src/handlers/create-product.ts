import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  getDefaultDepartmentId,
  getDefaultProductVatTypeId,
  getDefaultProductUnitId,
  findProductByName,
  findProductByNumber,
  findVatTypeIdByRate,
} from "../lib/tripletex-helpers.js";

interface Product {
  id: number;
  name: string;
}

let vatTypeBroken = false;

export function resetProductCache(): void {
  vatTypeBroken = false;
}

function buildProductBody(
  entity: Record<string, unknown>,
  departmentId: number,
  vatTypeId: number,
  unitId: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: entity.name ?? "",
    vatType: { id: vatTypeId },
    department: { id: departmentId },
    productUnit: { id: unitId },
  };

  const price =
    entity.unitPrice ?? entity.priceExcludingVatCurrency ?? entity.price;
  if (price !== undefined) body.priceExcludingVatCurrency = Number(price);

  if (entity.number ?? entity.productNumber) {
    body.number = entity.number ?? entity.productNumber;
  }
  if (entity.description) body.description = entity.description;
  if (entity.isStockItem !== undefined) body.isStockItem = entity.isStockItem;

  return body;
}

export async function handleCreateProduct(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const toCreate: { entity: Record<string, unknown> }[] = [];

  // First pass: search for existing products BEFORE warming caches.
  // Saves 3 API calls (dept + vatType + unit) when all products already exist.
  for (const entity of task.entities) {
    const productNumber = entity.number ?? entity.productNumber;
    const productName = String(entity.name ?? "");

    let existing: Product | null = null;
    if (productNumber) {
      existing = await findProductByNumber(client, String(productNumber));
    }
    if (!existing && productName) {
      existing = await findProductByName(client, productName);
    }

    if (existing) {
      console.log(`[Handler] Product already exists: ${productName} (id=${existing.id})`);
      if (productName) ctx.registerProduct(productName, existing.id);
      if (productNumber) ctx.registerProduct(String(productNumber), existing.id);
      continue;
    }

    toCreate.push({ entity });
  }

  if (toCreate.length === 0) {
    console.log("[Handler] All products already exist, nothing to create");
    return;
  }

  // Only warm caches when we actually need to create products
  const [departmentId, defaultVatTypeId, unitId] = await Promise.all([
    getDefaultDepartmentId(client),
    getDefaultProductVatTypeId(client),
    getDefaultProductUnitId(client),
  ]);

  const bodies: Record<string, unknown>[] = [];
  for (const { entity } of toCreate) {
    let vatTypeId = defaultVatTypeId;
    if (entity.vatRate !== undefined) {
      vatTypeId = await findVatTypeIdByRate(client, Number(entity.vatRate));
    }
    bodies.push(buildProductBody(entity, departmentId, vatTypeId, unitId));
  }

  const NO_VAT_FALLBACK_ID = 6;

  async function postProductWithFallback(body: Record<string, unknown>): Promise<Product> {
    if (vatTypeBroken) {
      delete body.vatType;
    }
    try {
      const result = await client.post<Product>("/product", body);
      return result.value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isVatError = msg.includes("vatTypeId") || msg.includes("mva-kode") || msg.includes("vatType");
      if (isVatError && !vatTypeBroken) {
        console.warn(`[Handler] vatType rejected, retrying without vatType for all products`);
        vatTypeBroken = true;
        delete body.vatType;
        try {
          const result = await client.post<Product>("/product", body);
          return result.value;
        } catch {
          body.vatType = { id: NO_VAT_FALLBACK_ID };
          const result = await client.post<Product>("/product", body);
          return result.value;
        }
      }
      throw err;
    }
  }

  if (bodies.length === 1) {
    const product = await postProductWithFallback(bodies[0]);
    console.log(`[Handler] Created product: id=${product.id}`);
    const name = String(bodies[0].name ?? "");
    if (name) ctx.registerProduct(name, product.id);
  } else {
    try {
      const result = await client.postList<Product>("/product/list", bodies);
      console.log(`[Handler] Created ${result.values.length} products`);
      for (const p of result.values) {
        if (p.name) ctx.registerProduct(p.name, p.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("vatTypeId") || msg.includes("mva-kode") || msg.includes("vatType")) {
        console.warn("[Handler] Batch product create failed on vatType, falling back to individual creates");
        for (const body of bodies) {
          const product = await postProductWithFallback(body);
          console.log(`[Handler] Created product: id=${product.id}`);
          const name = String(body.name ?? "");
          if (name) ctx.registerProduct(name, product.id);
        }
      } else {
        throw err;
      }
    }
  }
}
