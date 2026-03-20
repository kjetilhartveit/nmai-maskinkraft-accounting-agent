import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";

export async function handleCreateCustomer(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  for (const entity of task.entities) {
    const body: Record<string, unknown> = {
      name: entity.name ?? "",
      isCustomer: true,
    };

    if (entity.email) body.email = entity.email;
    if (entity.organizationNumber)
      body.organizationNumber = entity.organizationNumber;
    if (entity.phoneNumber) body.phoneNumber = entity.phoneNumber;
    if (entity.phoneNumberMobile)
      body.phoneNumberMobile = entity.phoneNumberMobile;

    const result = await client.post<{ id: number }>("/customer", body);
    console.log(`[Handler] Created customer: id=${result.value.id}`);
  }
}
