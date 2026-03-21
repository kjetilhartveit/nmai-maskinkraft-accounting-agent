import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";

interface LedgerAccount {
  id: number;
  number: number;
  name: string;
}

async function findAccount(
  client: TripletexClient,
  accountNumber: number,
): Promise<LedgerAccount> {
  const result = await client.list<LedgerAccount>("/ledger/account", {
    number: String(accountNumber),
    from: "0",
    count: "1",
  });
  const account = result.values[0];
  if (!account) throw new Error(`Ledger account ${accountNumber} not found`);
  return account;
}

/**
 * Ledger analysis handler.
 *
 * Analyzes the general ledger to find expense accounts with the largest increase
 * between two periods. Creates an internal project (and activity) for each one.
 */
export async function handleLedgerAnalysis(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};

  const accounts = (entity.accounts ?? entity.expenseAccounts ?? []) as Array<{
    accountNumber: number;
    name?: string;
    increase?: number;
  }>;

  const projectPrefix = String(entity.projectPrefix ?? entity.projectName ?? "Kostnadsanalyse");

  // Find the first employee to use as project manager
  const employees = await client.list<{ id: number; firstName: string; lastName: string }>(
    "/employee",
    { from: "0", count: "1" },
  );
  const pmId = employees.values[0]?.id;
  if (!pmId) throw new Error("No employee found to use as project manager");

  for (const acct of accounts) {
    const accountNumber = Number(acct.accountNumber ?? 0);
    if (accountNumber <= 0) continue;

    const accountInfo = await findAccount(client, accountNumber);
    const projectName = acct.name
      ? `${projectPrefix} – ${acct.name}`
      : `${projectPrefix} – Konto ${accountNumber}`;

    const project = await client.post<{ id: number }>("/project", {
      name: projectName.slice(0, 255),
      projectManager: { id: pmId },
      isInternal: true,
      isClosed: false,
    });
    console.log(`[Handler] Created analysis project: ${projectName} (id=${project.value.id}) for account ${accountNumber}`);

    ctx.registerProject(projectName, project.value.id);

    // Create an activity for the project
    try {
      await client.post("/project/activity", {
        project: { id: project.value.id },
        name: `Analyse konto ${accountNumber}`,
      });
      console.log(`[Handler] Created activity for project ${project.value.id}`);
    } catch (err) {
      console.warn(`[Handler] Could not create activity: ${err instanceof Error ? err.message : err}`);
    }
  }

  // If no accounts were provided by entity extraction, fall back to a single project
  if (accounts.length === 0) {
    const project = await client.post<{ id: number }>("/project", {
      name: String(entity.projectName ?? "Kostnadsanalyse"),
      projectManager: { id: pmId },
      isInternal: true,
      isClosed: false,
    });
    console.log(`[Handler] Created fallback analysis project: id=${project.value.id}`);
    ctx.registerProject("Kostnadsanalyse", project.value.id);
  }
}
