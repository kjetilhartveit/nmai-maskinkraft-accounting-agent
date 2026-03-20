import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
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
  ctx: SequenceContext,
): Promise<void> {
  // Check if a department was created earlier in the sequence that matches
  const deptName = String(task.entities[0]?.department ?? task.entities[0]?.departmentName ?? "");
  let departmentId = deptName ? ctx.getDepartmentId(deptName) : undefined;
  if (!departmentId) {
    departmentId = await getDefaultDepartmentId(client);
  } else {
    console.log(`[Handler] Using department from context: ${deptName} → id=${departmentId}`);
  }

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
        ctx.registerEmployee(String(entity.email), existing.id);
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
        ctx.registerEmployee(`${firstName} ${lastName}`, existing.id);
        continue;
      }
    }

    // Use department from entity if specified and present in context
    const entityDept = String(entity.department ?? entity.departmentName ?? "");
    const entityDeptId = entityDept ? ctx.getDepartmentId(entityDept) : undefined;
    const deptForEmployee = entityDeptId ?? departmentId;

    const body = buildEmployeeBody(entity, deptForEmployee);
    const result = await client.post<{ id: number }>("/employee", body);
    console.log(`[Handler] Created employee: id=${result.value.id}`);

    ctx.registerEmployee(`${firstName} ${lastName}`, result.value.id);
    if (entity.email) ctx.registerEmployee(String(entity.email), result.value.id);
  }
}
