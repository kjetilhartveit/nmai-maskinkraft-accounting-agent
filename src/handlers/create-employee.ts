import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";

export async function handleCreateEmployee(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  for (const entity of task.entities) {
    const body: Record<string, unknown> = {
      firstName: entity.firstName ?? "",
      lastName: entity.lastName ?? "",
    };

    if (entity.email) body.email = entity.email;
    if (entity.phoneNumber) body.phoneNumberMobile = entity.phoneNumber;
    if (entity.phoneNumberMobile)
      body.phoneNumberMobile = entity.phoneNumberMobile;

    const result = await client.post<{ id: number }>("/employee", body);
    console.log(`[Handler] Created employee: id=${result.value.id}`);

    if (entity.isAdmin) {
      // TODO: assign admin role via /employee/{id}/entitlement or similar endpoint
      console.log(
        `[Handler] TODO: Assign admin role to employee ${result.value.id}`,
      );
    }
  }
}
