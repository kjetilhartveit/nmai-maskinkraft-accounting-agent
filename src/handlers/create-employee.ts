import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import { getDefaultDepartmentId } from "../lib/tripletex-helpers.js";

export async function handleCreateEmployee(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  const departmentId = await getDefaultDepartmentId(client);

  for (const entity of task.entities) {
    const body: Record<string, unknown> = {
      firstName: entity.firstName ?? "",
      lastName: entity.lastName ?? "",
      userType: "STANDARD",
      department: { id: departmentId },
    };

    if (entity.email) body.email = entity.email;
    if (entity.phoneNumber) body.phoneNumberMobile = entity.phoneNumber;
    if (entity.phoneNumberMobile)
      body.phoneNumberMobile = entity.phoneNumberMobile;
    if (entity.dateOfBirth) body.dateOfBirth = entity.dateOfBirth;

    const result = await client.post<{ id: number }>("/employee", body);
    console.log(`[Handler] Created employee: id=${result.value.id}`);
  }
}
