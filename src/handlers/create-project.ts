import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findCustomerByName,
  findEmployeeByName,
  findEmployeeByEmail,
  getDefaultDepartmentId,
  today,
  getProjectManagerEmployeeId,
} from "../lib/tripletex-helpers.js";
import { grantProjectManagerEntitlement } from "./create-employee.js";

async function resolveProjectManagerId(
  client: TripletexClient,
  entity: Record<string, unknown>,
  ctx: SequenceContext,
): Promise<number | null> {
  const pmFirstName = String(entity.projectManagerFirstName ?? "");
  const pmLastName = String(entity.projectManagerLastName ?? "");
  const pmEmail = String(entity.projectManagerEmail ?? "");

  if (pmFirstName && pmLastName) {
    const ctxId = ctx.getEmployeeId(`${pmFirstName} ${pmLastName}`);
    if (ctxId) {
      console.log(`[Handler] Using project manager from context: ${pmFirstName} ${pmLastName} → id=${ctxId}`);
      return ctxId;
    }
    const emp = await findEmployeeByName(client, pmFirstName, pmLastName);
    if (emp) {
      console.log(`[Handler] Found project manager: ${pmFirstName} ${pmLastName} → id=${emp.id}`);
      return emp.id;
    }
  }

  if (pmEmail) {
    const ctxId = ctx.getEmployeeId(pmEmail);
    if (ctxId) {
      console.log(`[Handler] Using project manager from context (email): ${pmEmail} → id=${ctxId}`);
      return ctxId;
    }
    const emp = await findEmployeeByEmail(client, pmEmail);
    if (emp) {
      console.log(`[Handler] Found project manager by email: ${pmEmail} → id=${emp.id}`);
      return emp.id;
    }
  }

  return getProjectManagerEmployeeId(client);
}

export async function handleCreateProject(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const grantedPMs = new Set<number>();

  for (const entity of task.entities) {
    const customerName = String(entity.customerName ?? entity.customer ?? "");
    const ctxCustomerId = customerName ? ctx.getCustomerId(customerName) : undefined;

    // Parallel: resolve PM + department + customer (3 independent lookups)
    const [projectManagerId, departmentId, customerResult] = await Promise.all([
      resolveProjectManagerId(client, entity, ctx),
      getDefaultDepartmentId(client),
      !ctxCustomerId && customerName
        ? findCustomerByName(client, customerName)
        : Promise.resolve(null),
    ]);

    if (!projectManagerId) {
      console.warn("[Handler] No employee with project manager rights found, skipping entity");
      continue;
    }

    const body: Record<string, unknown> = {
      name: entity.name ?? entity.projectName ?? "",
      projectManager: { id: projectManagerId },
      department: { id: departmentId },
      startDate: String(entity.startDate ?? entity.date ?? today()),
      isInternal: !entity.customerName && !entity.customer && !entity.customerId,
    };

    if (entity.endDate) body.endDate = entity.endDate;
    if (entity.description) body.description = entity.description;

    if (ctxCustomerId) {
      console.log(`[Handler] Using customer from context: ${customerName} → id=${ctxCustomerId}`);
      body.customer = { id: ctxCustomerId };
    } else if (customerResult) {
      body.customer = { id: customerResult.id };
    } else if (entity.customerId) {
      body.customer = { id: Number(entity.customerId) };
    }

    try {
      const result = await client.post<{ id: number }>("/project", body);
      console.log(`[Handler] Created project: id=${result.value.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // On any 422, try fallback PM first (the first sandbox employee usually has PM rights).
      // This avoids wasted calls to BETA entitlement endpoints that usually return 403.
      const fallbackPM = await getProjectManagerEmployeeId(client);
      if (fallbackPM && fallbackPM !== projectManagerId) {
        console.log(`[Handler] Project creation failed, retrying with fallback PM id=${fallbackPM}`);
        body.projectManager = { id: fallbackPM };
        try {
          const result = await client.post<{ id: number }>("/project", body);
          console.log(`[Handler] Created project (fallback PM): id=${result.value.id}`);
          continue;
        } catch {
          // Fallback PM also failed — try granting entitlements as last resort
        }
      }

      // Last resort: try granting PM entitlements to the original employee
      const isPmError = msg.includes("prosjektleder") || msg.includes("project manager") || msg.includes("rettighet") || msg.includes("entitlement");
      if (isPmError && !grantedPMs.has(projectManagerId)) {
        const knownExtended = ctx.isEmployeeExtended(projectManagerId);
        const granted = await grantProjectManagerEntitlement(client, projectManagerId, knownExtended);
        grantedPMs.add(projectManagerId);
        if (granted) {
          body.projectManager = { id: projectManagerId };
          const result = await client.post<{ id: number }>("/project", body);
          console.log(`[Handler] Created project (after PM grant): id=${result.value.id}`);
          continue;
        }
      }
      throw err;
    }
  }
}
