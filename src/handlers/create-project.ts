import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import {
  findCustomerByName,
  findEmployeeByName,
  findEmployeeByEmail,
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
    let projectManagerId = await resolveProjectManagerId(client, entity, ctx);

    if (!projectManagerId) {
      console.warn("[Handler] No employee with project manager rights found, skipping entity");
      continue;
    }

    if (!grantedPMs.has(projectManagerId)) {
      const knownExtended = ctx.isEmployeeExtended(projectManagerId);
      const granted = await grantProjectManagerEntitlement(client, projectManagerId, knownExtended);
      grantedPMs.add(projectManagerId);
      
      if (!granted) {
        console.warn(`[Handler] Failed to grant PM rights to ${projectManagerId}. Falling back to default PM.`);
        const fallbackPM = await getProjectManagerEmployeeId(client);
        if (fallbackPM) {
            projectManagerId = fallbackPM;
        }
      }
    }

    const body: Record<string, unknown> = {
      name: entity.name ?? entity.projectName ?? "",
      projectManager: { id: projectManagerId },
      startDate: String(entity.startDate ?? entity.date ?? today()),
    };

    if (entity.endDate) body.endDate = entity.endDate;
    if (entity.description) body.description = entity.description;

    const customerName = String(entity.customerName ?? entity.customer ?? "");
    if (customerName) {
      const ctxCustomerId = ctx.getCustomerId(customerName);
      if (ctxCustomerId) {
        console.log(`[Handler] Using customer from context: ${customerName} → id=${ctxCustomerId}`);
        body.customer = { id: ctxCustomerId };
      } else {
        const customer = await findCustomerByName(client, customerName);
        if (customer) body.customer = { id: customer.id };
      }
    } else if (entity.customerId) {
      body.customer = { id: Number(entity.customerId) };
    }

    try {
      const result = await client.post<{ id: number }>("/project", body);
      console.log(`[Handler] Created project: id=${result.value.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("prosjektleder") || msg.includes("project manager")) {
        // PM entitlement failed — try with the default first employee
        const fallbackPM = await getProjectManagerEmployeeId(client);
        if (fallbackPM && fallbackPM !== projectManagerId) {
          console.log(`[Handler] PM entitlement failed, retrying with fallback PM id=${fallbackPM}`);
          if (!grantedPMs.has(fallbackPM)) {
            await grantProjectManagerEntitlement(client, fallbackPM, false);
            grantedPMs.add(fallbackPM);
          }
          body.projectManager = { id: fallbackPM };
          const result = await client.post<{ id: number }>("/project", body);
          console.log(`[Handler] Created project (fallback PM): id=${result.value.id}`);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }
}
