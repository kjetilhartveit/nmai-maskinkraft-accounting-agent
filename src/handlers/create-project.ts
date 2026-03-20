import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import {
  findCustomerByName,
  today,
  getProjectManagerEmployeeId,
} from "../lib/tripletex-helpers.js";

export async function handleCreateProject(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  // In Tripletex, the project manager must have special entitlements.
  // The first employee in the sandbox typically has these rights.
  // We always use them as the project manager regardless of parsed name.
  const projectManagerId = await getProjectManagerEmployeeId(client);

  if (!projectManagerId) {
    console.warn("[Handler] No employee with project manager rights found");
    return;
  }

  for (const entity of task.entities) {

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
