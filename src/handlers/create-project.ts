import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import {
  findEmployeeByName,
  findCustomerByName,
  today,
} from "../lib/tripletex-helpers.js";

interface Employee {
  id: number;
}

async function findFirstEmployeeWithProjectManager(
  client: TripletexClient,
): Promise<Employee | null> {
  // Tripletex requires the project manager to have project manager entitlements.
  // We fetch the list and return the first one — if none have the entitlement,
  // the API will reject and we surface the error.
  const result = await client.list<Employee>("/employee", {
    from: "0",
    count: "1",
  });
  return result.values[0] ?? null;
}

export async function handleCreateProject(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  for (const entity of task.entities) {
    // Resolve project manager
    let projectManagerId: number | null = null;
    const pmFirst = String(
      entity.projectManagerFirstName ?? entity.managerFirstName ?? "",
    );
    const pmLast = String(
      entity.projectManagerLastName ?? entity.managerLastName ?? "",
    );

    if (pmFirst && pmLast) {
      const pm = await findEmployeeByName(client, pmFirst, pmLast);
      if (pm) projectManagerId = pm.id;
    }
    if (!projectManagerId && entity.projectManagerId) {
      projectManagerId = Number(entity.projectManagerId);
    }
    if (!projectManagerId) {
      const fallback = await findFirstEmployeeWithProjectManager(client);
      if (fallback) projectManagerId = fallback.id;
    }

    if (!projectManagerId) {
      console.warn("[Handler] No project manager found, skipping project");
      continue;
    }

    const body: Record<string, unknown> = {
      name: entity.name ?? entity.projectName ?? "",
      projectManager: { id: projectManagerId },
      startDate: String(entity.startDate ?? entity.date ?? today()),
    };

    if (entity.endDate) body.endDate = entity.endDate;
    if (entity.description) body.description = entity.description;

    // Resolve customer
    const customerName = String(entity.customerName ?? entity.customer ?? "");
    if (customerName) {
      const customer = await findCustomerByName(client, customerName);
      if (customer) body.customer = { id: customer.id };
    } else if (entity.customerId) {
      body.customer = { id: Number(entity.customerId) };
    }

    const result = await client.post<{ id: number }>("/project", body);
    console.log(`[Handler] Created project: id=${result.value.id}`);
  }
}
