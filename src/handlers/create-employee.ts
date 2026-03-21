import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  getDefaultDepartmentId,
  getCompanyId,
  setCompanyId,
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
    body.userType = "EXTENDED";
  }

  if (entity.phoneNumber) body.phoneNumberMobile = entity.phoneNumber;
  if (entity.phoneNumberMobile) body.phoneNumberMobile = entity.phoneNumberMobile;
  if (entity.dateOfBirth) body.dateOfBirth = entity.dateOfBirth;
  if (entity.employeeNumber) body.employeeNumber = entity.employeeNumber;
  return body;
}

const ENTITLEMENT_ADMIN = 1;            // ROLE_ADMINISTRATOR
const ENTITLEMENT_PM = 10;              // AUTH_PROJECT_MANAGER
const ENTITLEMENT_CREATE_PROJECT = 45;  // AUTH_CREATE_PROJECT (prerequisite for PM)

async function grantEntitlement(
  client: TripletexClient,
  employeeId: number,
  entitlementId: number,
  companyId: number,
  label: string,
): Promise<boolean> {
  try {
    await client.post("/employee/entitlement", {
      employee: { id: employeeId },
      entitlementId,
      customer: { id: companyId },
    });
    console.log(`[Handler] Granted ${label} (entitlementId=${entitlementId}) to employee ${employeeId}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403")) {
      console.warn(`[Handler] Entitlement endpoint returned 403 (BETA endpoint, not available in sandbox). Continuing without ${label}.`);
    } else {
      console.warn(`[Handler] Failed to grant ${label}: ${msg}`);
    }
    return false;
  }
}

async function ensureExtendedAccess(
  client: TripletexClient,
  employeeId: number,
): Promise<boolean> {
  try {
    const emp = await client.get<{
      id: number;
      version: number;
      userType: string | null;
      firstName: string;
      lastName: string;
      email: string | null;
      dateOfBirth: string | null;
    }>(`/employee/${employeeId}`);
    if (emp.value.userType === "EXTENDED") return true;
    await client.put(`/employee/${employeeId}`, {
      id: employeeId,
      version: emp.value.version,
      firstName: emp.value.firstName,
      lastName: emp.value.lastName,
      email: emp.value.email,
      dateOfBirth: emp.value.dateOfBirth ?? "1990-01-01",
      userType: "EXTENDED",
    });
    console.log(`[Handler] Upgraded employee ${employeeId} to EXTENDED access`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("422")) {
      console.warn(`[Handler] Employee ${employeeId} userType is write-once; cannot upgrade to EXTENDED`);
    } else {
      console.warn(`[Handler] Failed to upgrade employee to EXTENDED: ${msg}`);
    }
    return false;
  }
}

async function grantAdminEntitlement(
  client: TripletexClient,
  employeeId: number,
  knownExtended = false,
): Promise<void> {
  if (!knownExtended) {
    const ok = await ensureExtendedAccess(client, employeeId);
    if (!ok) {
      console.warn(`[Handler] Skipping admin entitlement — employee ${employeeId} does not have EXTENDED access`);
      return;
    }
  }
  const companyId = await getCompanyId(client);
  await grantEntitlement(client, employeeId, ENTITLEMENT_ADMIN, companyId, "ROLE_ADMINISTRATOR");
}

export async function grantProjectManagerEntitlement(
  client: TripletexClient,
  employeeId: number,
  knownExtended = false,
): Promise<boolean> {
  if (!knownExtended) {
    const ok = await ensureExtendedAccess(client, employeeId);
    if (!ok) {
      console.warn(`[Handler] Skipping PM entitlement — employee ${employeeId} does not have EXTENDED access`);
      return false;
    }
  }
  const companyId = await getCompanyId(client);
  const ok1 = await grantEntitlement(client, employeeId, ENTITLEMENT_CREATE_PROJECT, companyId, "AUTH_CREATE_PROJECT");
  const ok2 = await grantEntitlement(client, employeeId, ENTITLEMENT_PM, companyId, "AUTH_PROJECT_MANAGER");
  return ok1 && ok2;
}

async function createEmployment(
  client: TripletexClient,
  employeeId: number,
  startDate: string,
): Promise<void> {
  try {
    await client.post("/employee/employment", {
      employee: { id: employeeId },
      startDate,
      employmentType: "ORDINARY",
      percentageOfFullTimeEquivalent: 100,
    });
    console.log(`[Handler] Created employment for employee ${employeeId}, startDate=${startDate}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Handler] Failed to create employment: ${msg}`);
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
    const firstName = String(entity.firstName ?? "");
    const lastName = String(entity.lastName ?? "");
    const hasEmail = Boolean(entity.email);

    let existing: { id: number } | null = null;

    if (hasEmail) {
      existing = await findEmployeeByEmail(client, String(entity.email));
      if (existing) {
        console.log(`[Handler] Employee with email ${entity.email} already exists: id=${existing.id}`);
        ctx.registerEmployee(String(entity.email), existing.id);
        if (firstName && lastName) ctx.registerEmployee(`${firstName} ${lastName}`, existing.id);
        if (isAdminRequested(entity)) {
          await grantAdminEntitlement(client, existing.id);
        }
        continue;
      }
    } else if (firstName && lastName) {
      existing = await findEmployeeByName(client, firstName, lastName);
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
    let result: { value: { id: number; companyId?: number } };
    try {
      result = await client.post<{ id: number; companyId?: number }>("/employee", body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("422")) {
        // Retry: strip optional fields that might cause validation errors
        const retryBody: Record<string, unknown> = {
          firstName: body.firstName,
          lastName: body.lastName,
          department: body.department,
        };
        if (body.email) {
          retryBody.email = body.email;
          retryBody.userType = "EXTENDED";
        }
        console.warn(`[Handler] Employee creation failed, retrying with minimal fields`);
        result = await client.post<{ id: number; companyId?: number }>("/employee", retryBody);
      } else {
        throw err;
      }
    }
    const empId = result.value.id;
    console.log(`[Handler] Created employee: id=${empId}`);

    if (result.value.companyId) {
      setCompanyId(result.value.companyId);
    }

    const createdAsExtended = hasEmail;

    if (createdAsExtended) {
      ctx.registerEmployeeExtended(empId);
    }

    if (isAdminRequested(entity)) {
      await grantAdminEntitlement(client, empId, createdAsExtended);
    }

    if (entity.startDate) {
      await createEmployment(client, empId, String(entity.startDate));
    }

    if (firstName && lastName) ctx.registerEmployee(`${firstName} ${lastName}`, empId);
    if (hasEmail) ctx.registerEmployee(String(entity.email), empId);
  }
}
