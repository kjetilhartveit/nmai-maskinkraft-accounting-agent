import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";

export async function handleCreateSupplier(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  for (const entity of task.entities) {
    const body: Record<string, unknown> = {
      name: entity.name ?? "",
      isSupplier: true,
    };

    if (entity.email) body.email = entity.email;
    if (entity.organizationNumber)
      body.organizationNumber = entity.organizationNumber;
    if (entity.phoneNumber) body.phoneNumber = entity.phoneNumber;
    if (entity.phoneNumberMobile)
      body.phoneNumberMobile = entity.phoneNumberMobile;

    const result = await client.post<{ id: number }>("/supplier", body);
    console.log(`[Handler] Created supplier: id=${result.value.id}`);
  }
}
