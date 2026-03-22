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

interface Activity {
  id: number;
  name: string;
  number: string;
}

export async function handleLedgerAnalysis(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  const entity = task.entities[0] ?? {};
  const pmId = await getProjectManagerEmployeeId(client);
  if (!pmId) throw new Error("No employee found to use as project manager");
  const departmentId = await getDefaultDepartmentId(client);

  const postingFields = "id,date,account(id,number,name),amount,amountGross";
  const [janPostings, febPostings] = await Promise.all([
    client.list<Posting>("/ledger/posting", {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      from: "0",
      count: "10000",
      fields: postingFields,
    }),
    client.list<Posting>("/ledger/posting", {
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      from: "0",
      count: "10000",
      fields: postingFields,
    }),
  ]);

  console.log(`[Handler] Postings: Jan=${janPostings.values.length}, Feb=${febPostings.values.length}`);

  const janTotals = new Map<number, { total: number; name: string }>();
  const febTotals = new Map<number, { total: number; name: string }>();

  function aggregate(postings: Posting[], map: Map<number, { total: number; name: string }>, label: string) {
    for (const p of postings) {
      const acctNum = p.account?.number;
      if (acctNum >= 4000 && acctNum <= 7999) {
        const amt = p.amount ?? p.amountGross ?? 0;
        const existing = map.get(acctNum) ?? { total: 0, name: p.account.name };
        existing.total += amt;
        map.set(acctNum, existing);
      }
    }
    console.log(`[Handler] ${label} expense totals: ${[...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}=${v.total}`).join(", ")}`);
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

  const accountsToProcess = top3.length > 0 ? top3 : (
    (Array.isArray(entity.accounts) ? entity.accounts : []) as Array<{ accountNumber: number; name?: string }>
  ).map(a => ({ accountNumber: Number(a.accountNumber), name: a.name ?? `Konto ${a.accountNumber}`, increase: 0 }));

  if (accountsToProcess.length === 0) {
    for (let i = 1; i <= 3; i++) {
      const project = await client.post<{ id: number }>("/project", {
        name: `Kostnadsanalyse ${i}`,
        projectManager: { id: pmId },
        department: { id: departmentId },
        startDate: today(),
        isInternal: true,
      });
      const uniqueLabel = `Kostnadsanalyse ${i} (prosjekt ${project.value.id})`;
      console.log(`[Handler] Created generic analysis project ${i}: id=${project.value.id}`);
      await createProjectActivity(client, uniqueLabel, 90000 + i);
    }
    return;
  }

  let activitySeq = 1;
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
    const activityLabel = `${acct.accountNumber} ${projectName}`.trim().slice(0, 255);
    await createProjectActivity(client, activityLabel, acct.accountNumber || (90000 + activitySeq));
    activitySeq++;
  }
}

async function createProjectActivity(
  client: TripletexClient,
  name: string,
  activityNumber: number,
): Promise<number> {
  const existing = await client.list<Activity>("/activity", { from: "0", count: "2000" });
  const match = existing.values.find(a => a.name?.toLowerCase().trim() === name.toLowerCase().trim());
  if (match) {
    console.log(`[Helper] Found existing activity: "${name}" id=${match.id}`);
    return match.id;
  }

  try {
    const result = await client.post<Activity>("/activity", {
      name: name.slice(0, 255),
      number: activityNumber,
      activityType: "PROJECT_GENERAL_ACTIVITY",
      isProjectActivity: true,
    });
    console.log(`[Helper] Created activity: "${name}" number=${activityNumber} id=${result.value.id}`);
    return result.value.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("422") || msg.includes("i bruk") || msg.includes("in use")) {
      const refreshed = await client.list<Activity>("/activity", { from: "0", count: "2000" });
      const retry = refreshed.values.find(a => a.name?.toLowerCase().trim() === name.toLowerCase().trim());
      if (retry) return retry.id;
    }
    const suffix = ` #${activityNumber}`;
    const short = name.slice(0, Math.max(1, 255 - suffix.length));
    const fallbackResult = await client.post<Activity>("/activity", {
      name: `${short}${suffix}`.slice(0, 255),
      activityType: "PROJECT_GENERAL_ACTIVITY",
    });
    return fallbackResult.value.id;
  }
}
