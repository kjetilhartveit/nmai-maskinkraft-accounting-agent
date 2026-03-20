import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import { getDefaultDepartmentId } from "../lib/tripletex-helpers.js";

function buildEmployeeBody(
  entity: Record<string, unknown>,
  departmentId: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    firstName: entity.firstName ?? "",
    lastName: entity.lastName ?? "",
    department: { id: departmentId },
  };

  if (entity.email) {
    body.email = entity.email;
    body.userType = "STANDARD";
  } else {
    body.userType = entity.userType ?? "NO_ACCESS";
  }

  if (entity.phoneNumber) body.phoneNumberMobile = entity.phoneNumber;
  if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;
  if (entity.dateOfBirth) body.dateOfBirth = entity.dateOfBirth;
  if (entity.employeeNumber) body.employeeNumber = entity.employeeNumber;
  return body;
}

export async function handleCreateEmployee(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  const departmentId = await getDefaultDepartmentId(client);
  const bodies = task.entities.map((e) => buildEmployeeBody(e, departmentId));

  if (bodies.length === 1) {
    const result = await client.post<{ id: number }>("/employee", bodies[0]);
    console.log(`[Handler] Created employee: id=${result.value.id}`);
  } else {
    const result = await client.postList<{ id: number }>("/employee/list", bodies);
    console.log(`[Handler] Created ${result.values.length} employees`);
  }
}
