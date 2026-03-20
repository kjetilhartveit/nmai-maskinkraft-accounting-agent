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
  const [departmentId, defaultVatTypeId, unitId] = await Promise.all([
    getDefaultDepartmentId(client),
    getDefaultProductVatTypeId(client),
    getDefaultProductUnitId(client),
  ]);

  const toCreate: Record<string, unknown>[] = [];

  for (const entity of task.entities) {
    // Search for existing product by number first, then by name
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

    let vatTypeId = defaultVatTypeId;
    if (entity.vatRate !== undefined) {
      vatTypeId = await findVatTypeIdByRate(client, Number(entity.vatRate));
    }

    toCreate.push(buildProductBody(entity, departmentId, vatTypeId, unitId));
  }

  if (toCreate.length === 0) {
    console.log("[Handler] All products already exist, nothing to create");
    return;
  }

  if (toCreate.length === 1) {
    const result = await client.post<Product>("/product", toCreate[0]);
    console.log(`[Handler] Created product: id=${result.value.id}`);
    const name = String(toCreate[0].name ?? "");
    if (name) ctx.registerProduct(name, result.value.id);
  } else {
    const result = await client.postList<Product>("/product/list", toCreate);
    console.log(`[Handler] Created ${result.values.length} products`);
    for (const p of result.values) {
      if (p.name) ctx.registerProduct(p.name, p.id);
    }
  }
}
