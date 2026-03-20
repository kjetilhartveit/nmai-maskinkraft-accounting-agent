import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  getDefaultDepartmentId,
  findEmployeeByEmail,
  findEmployeeByName,
} from "../lib/tripletex-helpers.js";

function isAdminRequested(entity: Record<string, unknown>): boolean {
  const t = String(entity.userType ?? "").toUpperCase();
  return t === "ADMINISTRATOR" || t === "ADMIN";
}

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
    body.userType = "NO_ACCESS";
  }

  if (entity.phoneNumber) body.phoneNumberMobile = entity.phoneNumber;
  if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;
  if (entity.dateOfBirth) body.dateOfBirth = entity.dateOfBirth;
  if (entity.employeeNumber) body.employeeNumber = entity.employeeNumber;
  return body;
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

export async function grantProjectManagerEntitlement(
  client: TripletexClient,
  employeeId: number,
): Promise<void> {
  try {
    await client.post("/employee/entitlement", {
      employee: { id: employeeId },
      entitlement: "PROJECT_MANAGER",
    });
    console.log(`[Handler] Granted PROJECT_MANAGER entitlement to employee ${employeeId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Handler] Failed to grant PROJECT_MANAGER entitlement: ${msg}`);
  }
}

export async function handleCreateEmployee(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const deptName = String(task.entities[0]?.department ?? task.entities[0]?.departmentName ?? "");
  let departmentId = deptName ? ctx.getDepartmentId(deptName) : undefined;
  if (!departmentId) {
    departmentId = await getDefaultDepartmentId(client);
  } else {
    console.log(`[Handler] Using department from context: ${deptName} → id=${departmentId}`);
  }

  for (const entity of task.entities) {
    if (entity.email) {
      const existing = await findEmployeeByEmail(client, String(entity.email));
      if (existing) {
        console.log(`[Handler] Employee with email ${entity.email} already exists: id=${existing.id}`);
        ctx.registerEmployee(String(entity.email), existing.id);
        if (isAdminRequested(entity)) {
          await grantAdminEntitlement(client, existing.id);
        }
        continue;
      }
    }

    const firstName = String(entity.firstName ?? "");
    const lastName = String(entity.lastName ?? "");
    if (firstName && lastName) {
      const existing = await findEmployeeByName(client, firstName, lastName);
      if (existing) {
        console.log(`[Handler] Employee ${firstName} ${lastName} already exists: id=${existing.id}`);
        ctx.registerEmployee(`${firstName} ${lastName}`, existing.id);
        if (isAdminRequested(entity)) {
          await grantAdminEntitlement(client, existing.id);
        }
        continue;
      }
    }

    const entityDept = String(entity.department ?? entity.departmentName ?? "");
    const entityDeptId = entityDept ? ctx.getDepartmentId(entityDept) : undefined;
    const deptForEmployee = entityDeptId ?? departmentId;

    const body = buildEmployeeBody(entity, deptForEmployee);
    const result = await client.post<{ id: number }>("/employee", body);
    const empId = result.value.id;
    console.log(`[Handler] Created employee: id=${empId}`);

    if (isAdminRequested(entity)) {
      await grantAdminEntitlement(client, empId);
    }

    ctx.registerEmployee(`${firstName} ${lastName}`, empId);
    if (entity.email) ctx.registerEmployee(String(entity.email), empId);
  }
}
