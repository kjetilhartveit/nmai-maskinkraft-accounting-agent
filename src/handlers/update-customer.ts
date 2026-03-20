import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import { findCustomerByName } from "../lib/tripletex-helpers.js";

export async function handleUpdateCustomer(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  for (const entity of task.entities) {
    const name = String(entity.name ?? "");

    const existing = await findCustomerByName(client, name);
    if (!existing) {
      console.warn(`[Handler] Customer not found: ${name}`);
      continue;
    }

    const current = await client.get<{ id: number; version: number }>(
      `/customer/${existing.id}`,
    );

    const body: Record<string, unknown> = {
      id: existing.id,
      version: current.value.version,
      name,
      isCustomer: true,
    };

    if (entity.email) body.email = entity.email;
    if (entity.organizationNumber) body.organizationNumber = entity.organizationNumber;
    if (entity.phoneNumber) body.phoneNumber = entity.phoneNumber;
    if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;

    await client.put<{ id: number }>(`/customer/${existing.id}`, body);
    console.log(`[Handler] Updated customer: id=${existing.id}`);
  }
}
