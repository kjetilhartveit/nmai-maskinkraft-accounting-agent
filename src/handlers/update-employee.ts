import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { findEmployeeByName } from "../lib/tripletex-helpers.js";

export async function handleUpdateEmployee(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  for (const entity of task.entities) {
    const firstName = String(entity.firstName ?? "");
    const lastName = String(entity.lastName ?? "");

    const existing = await findEmployeeByName(client, firstName, lastName);
    if (!existing) {
      console.warn(`[Handler] Employee not found: ${firstName} ${lastName}`);
      continue;
    }

    // Fetch current version for optimistic locking
    const current = await client.get<{ id: number; version: number }>(
      `/employee/${existing.id}`,
    );

    const body: Record<string, unknown> = {
      id: existing.id,
      version: current.value.version,
      firstName,
      lastName,
    };

    if (entity.email) {
      body.email = entity.email;
      body.userType = "STANDARD";
    }
    if (entity.phoneNumber) body.phoneNumberMobile = entity.phoneNumber;
    if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;
    if (entity.dateOfBirth) body.dateOfBirth = entity.dateOfBirth;

    await client.put<{ id: number }>(`/employee/${existing.id}`, body);
    console.log(`[Handler] Updated employee: id=${existing.id}`);
  }
}
