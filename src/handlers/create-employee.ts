import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import {
  getDefaultDepartmentId,
  findEmployeeByEmail,
  findEmployeeByName,
} from "../lib/tripletex-helpers.js";

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

  for (const entity of task.entities) {
    // Check if employee already exists by email
    if (entity.email) {
      const existing = await findEmployeeByEmail(
        client,
        String(entity.email),
      );
      if (existing) {
        console.log(
          `[Handler] Employee with email ${entity.email} already exists: id=${existing.id}`,
        );
        continue;
      }
    }

    // Check if employee already exists by name
    const firstName = String(entity.firstName ?? "");
    const lastName = String(entity.lastName ?? "");
    if (firstName && lastName) {
      const existing = await findEmployeeByName(client, firstName, lastName);
      if (existing) {
        console.log(
          `[Handler] Employee ${firstName} ${lastName} already exists: id=${existing.id}`,
        );
        continue;
      }
    }

    // Create new employee
    const body = buildEmployeeBody(entity, departmentId);
    const result = await client.post<{ id: number }>("/employee", body);
    console.log(`[Handler] Created employee: id=${result.value.id}`);
  }
}
