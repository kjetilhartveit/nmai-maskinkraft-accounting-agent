import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";

export async function handleCreateDepartment(
  client: TripletexClient,
  task: ParsedTask,
): Promise<void> {
  for (const entity of task.entities) {
    const body: Record<string, unknown> = {
      name: entity.name ?? entity.departmentName ?? "",
    };

    if (entity.departmentNumber)
      body.departmentNumber = entity.departmentNumber;

    const result = await client.post<{ id: number }>("/department", body);
    console.log(`[Handler] Created department: id=${result.value.id}`);
  }
}
