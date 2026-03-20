import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";

function buildCustomerBody(entity: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: entity.name ?? "",
    isCustomer: true,
  };
  if (entity.email) body.email = entity.email;
  if (entity.organizationNumber) body.organizationNumber = entity.organizationNumber;
  if (entity.phoneNumber) body.phoneNumber = entity.phoneNumber;
  if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;
  if (entity.postalAddress) body.postalAddress = entity.postalAddress;
  return body;
}

export async function handleCreateCustomer(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const bodies = task.entities.map(buildCustomerBody);

  if (bodies.length === 1) {
    const result = await client.post<{ id: number }>("/customer", bodies[0]);
    const name = String(bodies[0].name ?? "");
    ctx.registerCustomer(name, result.value.id);
    console.log(`[Handler] Created customer: id=${result.value.id}`);
  } else {
    const result = await client.postList<{ id: number }>("/customer/list", bodies);
    result.values.forEach((v, i) => {
      const name = String(bodies[i]?.name ?? "");
      ctx.registerCustomer(name, v.id);
    });
    console.log(`[Handler] Created ${result.values.length} customers`);
  }
}
