import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, getDefaultDepartmentId, getProjectManagerEmployeeId } from "../lib/tripletex-helpers.js";

interface Posting {
  account: { id: number; number: number; name: string };
  amount: number;
  amountGross: number;
  date: string;
}

/**
 * Ledger analysis handler.
 *
 * Queries postings for two periods, compares expense accounts (4000-7999),
 * finds the three with the largest cost increase, and creates a project + activity for each.
 */
export async function handleLedgerAnalysis(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};
  const pmId = await getProjectManagerEmployeeId(client);
  if (!pmId) throw new Error("No employee found to use as project manager");
  const departmentId = await getDefaultDepartmentId(client);

  const [janPostings, febPostings] = await Promise.all([
    client.list<Posting>("/ledger/posting", {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      from: "0",
      count: "10000",
    }),
    client.list<Posting>("/ledger/posting", {
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      from: "0",
      count: "10000",
    }),
  ]);

  console.log(`[Handler] Postings: Jan=${janPostings.values.length}, Feb=${febPostings.values.length}`);

  if (janPostings.values.length > 0) {
    const sample = janPostings.values[0];
    console.log(`[Handler] Sample posting keys: ${Object.keys(sample).join(", ")}`);
    console.log(`[Handler] Sample: acct=${sample.account?.number}, amt=${sample.amount}, gross=${sample.amountGross}`);
  }

  const janTotals = new Map<number, { total: number; name: string }>();
  const febTotals = new Map<number, { total: number; name: string }>();

  function aggregate(postings: Posting[], map: Map<number, { total: number; name: string }>, label: string) {
    const accountsSeen = new Set<number>();
    for (const p of postings) {
      const acctNum = p.account?.number;
      if (acctNum) accountsSeen.add(acctNum);
      if (acctNum >= 4000 && acctNum <= 7999) {
        const amt = p.amount ?? p.amountGross ?? 0;
        if (amt !== 0) {
          const absAmt = Math.abs(amt);
          const existing = map.get(acctNum) ?? { total: 0, name: p.account.name };
          existing.total += absAmt;
          map.set(acctNum, existing);
        }
      }
    }
    console.log(`[Handler] ${label} accounts seen: ${[...accountsSeen].sort((a, b) => a - b).join(", ")}`);
    console.log(`[Handler] ${label} expense totals: ${[...map.entries()].map(([k, v]) => `${k}=${v.total}`).join(", ")}`);
  }

  aggregate(janPostings.values, janTotals, "Jan");
  aggregate(febPostings.values, febTotals, "Feb");

  const increases: { accountNumber: number; name: string; increase: number }[] = [];
  const allAccounts = new Set([...janTotals.keys(), ...febTotals.keys()]);
  for (const acct of allAccounts) {
    const janAmount = janTotals.get(acct)?.total ?? 0;
    const febAmount = febTotals.get(acct)?.total ?? 0;
    const increase = febAmount - janAmount;
    if (increase > 0) {
      const name = febTotals.get(acct)?.name ?? janTotals.get(acct)?.name ?? `Konto ${acct}`;
      increases.push({ accountNumber: acct, name, increase });
    }
  }

  if (increases.length === 0) {
    for (const acct of allAccounts) {
      if (febTotals.has(acct)) {
        const name = febTotals.get(acct)?.name ?? `Konto ${acct}`;
        const total = febTotals.get(acct)?.total ?? 0;
        increases.push({ accountNumber: acct, name, increase: total });
      }
    }
  }

  increases.sort((a, b) => b.increase - a.increase);
  const top3 = increases.slice(0, 3);
  console.log(`[Handler] Top 3 expense increases: ${top3.map(a => `${a.accountNumber} (${a.name}): +${a.increase}`).join(", ")}`);

  // If no data from vouchers, use entity-extracted accounts as fallback
  const accountsToProcess = top3.length > 0 ? top3 : (
    (Array.isArray(entity.accounts) ? entity.accounts : []) as Array<{ accountNumber: number; name?: string }>
  ).map(a => ({ accountNumber: Number(a.accountNumber), name: a.name ?? `Konto ${a.accountNumber}`, increase: 0 }));

  if (accountsToProcess.length === 0) {
    for (let i = 1; i <= 3; i++) {
      const name = `Kostnadsanalyse ${i}`;
      const project = await client.post<{ id: number }>("/project", {
        name,
        projectManager: { id: pmId },
        department: { id: departmentId },
        startDate: today(),
        isInternal: true,
      });
      console.log(`[Handler] Created generic analysis project ${i}: id=${project.value.id}`);

      try {
        await client.post("/activity", {
          name,
          activityType: "PROJECT_GENERAL_ACTIVITY",
        });
      } catch {
        console.warn(`[Handler] Could not create activity for project ${project.value.id}`);
      }
    }
    return;
  }

  for (const acct of accountsToProcess) {
    const projectName = acct.name;

    const project = await client.post<{ id: number }>("/project", {
      name: projectName.slice(0, 255),
      projectManager: { id: pmId },
      department: { id: departmentId },
      startDate: today(),
      isInternal: true,
    });
    console.log(`[Handler] Created analysis project: ${projectName} (id=${project.value.id})`);
    ctx.registerProject(projectName, project.value.id);

    try {
      await client.post("/activity", {
        name: projectName.slice(0, 255),
        activityType: "PROJECT_GENERAL_ACTIVITY",
      });
      console.log(`[Handler] Created activity: ${projectName}`);
    } catch (err) {
      console.warn(`[Handler] Could not create activity: ${err instanceof Error ? err.message : err}`);
    }
  }
}
