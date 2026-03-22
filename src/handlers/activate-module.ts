import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";

/**
 * POST /company/salesmodules is BETA and returns 403 in the sandbox.
 * All modules are pre-enabled, so this is a successful no-op.
 */
export async function handleActivateModule(
  _client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  const moduleName = task.entities[0]?.moduleName ?? "unknown";
  console.log(`[Handler] Module "${moduleName}" is pre-enabled in sandbox — no API call needed`);
}
