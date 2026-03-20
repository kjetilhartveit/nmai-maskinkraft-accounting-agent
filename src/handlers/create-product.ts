import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  getDefaultDepartmentId,
  getDefaultProductVatTypeId,
  getDefaultProductUnitId,
} from "../lib/tripletex-helpers.js";

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
  _ctx: SequenceContext,
): Promise<void> {
  const [departmentId, vatTypeId, unitId] = await Promise.all([
    getDefaultDepartmentId(client),
    getDefaultProductVatTypeId(client),
    getDefaultProductUnitId(client),
  ]);

  const bodies = task.entities.map((e) =>
    buildProductBody(e, departmentId, vatTypeId, unitId),
  );

  if (bodies.length === 1) {
    const result = await client.post<{ id: number }>("/product", bodies[0]);
    console.log(`[Handler] Created product: id=${result.value.id}`);
  } else {
    const result = await client.postList<{ id: number }>("/product/list", bodies);
    console.log(`[Handler] Created ${result.values.length} products`);
  }
}
