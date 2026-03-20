import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";

function buildSupplierBody(entity: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: entity.name ?? "",
    isSupplier: true,
  };
  if (entity.email) body.email = entity.email;
  if (entity.organizationNumber) body.organizationNumber = entity.organizationNumber;
  if (entity.phoneNumber) body.phoneNumber = entity.phoneNumber;
  if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;
  return body;
}

export async function handleCreateSupplier(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const bodies = task.entities.map(buildSupplierBody);

  if (bodies.length === 1) {
    const result = await client.post<{ id: number }>("/supplier", bodies[0]);
    const name = String(bodies[0].name ?? "");
    ctx.registerSupplier(name, result.value.id);
    console.log(`[Handler] Created supplier: id=${result.value.id}`);
  } else {
    const result = await client.postList<{ id: number }>("/supplier/list", bodies);
    result.values.forEach((v, i) => {
      const name = String(bodies[i]?.name ?? "");
      ctx.registerSupplier(name, v.id);
    });
    console.log(`[Handler] Created ${result.values.length} suppliers`);
  }
}
