import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { findEmployeeByName } from "../lib/tripletex-helpers.js";
import { grantProjectManagerEntitlement } from "./create-employee.js";

function isAdminRequested(entity: Record<string, unknown>): boolean {
  const t = String(entity.userType ?? "").toUpperCase();
  return t === "ADMINISTRATOR" || t === "ADMIN";
}

async function grantAdminEntitlement(
  client: TripletexClient,
  employeeId: number,
): Promise<void> {
  try {
    await client.post("/employee/entitlement", {
      employee: { id: employeeId },
      entitlement: "ADMINISTRATOR",
    });
    console.log(`[Handler] Granted ADMINISTRATOR entitlement to employee ${employeeId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Handler] Failed to grant ADMINISTRATOR entitlement: ${msg}`);
  }
}

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

    const current = await client.get<{ id: number; version: number }>(
      `/employee/${existing.id}`,
    );

    const body: Record<string, unknown> = {
      id: existing.id,
      version: current.value.version,
      firstName,
      lastName,
    };

    if (entity.email) body.email = entity.email;
    if (entity.phoneNumber) body.phoneNumberMobile = entity.phoneNumber;
    if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;
    if (entity.dateOfBirth) body.dateOfBirth = entity.dateOfBirth;

    await client.put<{ id: number }>(`/employee/${existing.id}`, body);
    console.log(`[Handler] Updated employee: id=${existing.id}`);

    if (isAdminRequested(entity)) {
      await grantAdminEntitlement(client, existing.id);
    }
  }
}
