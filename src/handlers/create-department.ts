import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";

export async function handleCreateDepartment(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const bodies = task.entities.map((entity) => {
    const body: Record<string, unknown> = {
      name: entity.name ?? entity.departmentName ?? "",
    };
    if (entity.departmentNumber) body.departmentNumber = entity.departmentNumber;
    return body;
  });

  if (bodies.length === 1) {
    const result = await client.post<{ id: number }>("/department", bodies[0]);
    const name = String(bodies[0].name ?? "");
    ctx.registerDepartment(name, result.value.id);
    console.log(`[Handler] Created department: id=${result.value.id}`);
  } else {
    const result = await client.postList<{ id: number }>("/department/list", bodies);
    result.values.forEach((v, i) => {
      const name = String(bodies[i]?.name ?? "");
      ctx.registerDepartment(name, v.id);
    });
    console.log(`[Handler] Created ${result.values.length} departments`);
  }
}
