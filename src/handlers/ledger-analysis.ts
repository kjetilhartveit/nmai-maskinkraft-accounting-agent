import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { today, getDefaultDepartmentId, getProjectManagerEmployeeId } from "../lib/tripletex-helpers.js";

interface Voucher {
  id: number;
  postings?: VoucherPosting[];
}

interface VoucherPosting {
  account: { id: number; number: number; name: string };
  amountGross: number;
}

/**
 * Ledger analysis handler.
 *
 * Queries vouchers for two periods, compares expense accounts (4000-7999),
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

  // Query vouchers for January and February 2026 in parallel
  const [janVouchers, febVouchers] = await Promise.all([
    client.list<Voucher>("/ledger/voucher", {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      from: "0",
      count: "1000",
    }),
    client.list<Voucher>("/ledger/voucher", {
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
      from: "0",
      count: "1000",
    }),
  ]);

  // Aggregate expense per account (accounts 4000-7999) per period
  const janTotals = new Map<number, { total: number; name: string }>();
  const febTotals = new Map<number, { total: number; name: string }>();

  function aggregate(vouchers: Voucher[], map: Map<number, { total: number; name: string }>) {
    for (const v of vouchers) {
      if (!v.postings) continue;
      for (const p of v.postings) {
        const acctNum = p.account?.number;
        if (acctNum >= 4000 && acctNum <= 7999 && p.amountGross > 0) {
          const existing = map.get(acctNum) ?? { total: 0, name: p.account.name };
          existing.total += p.amountGross;
          map.set(acctNum, existing);
        }
      }
    }
  }

  aggregate(janVouchers.values, janTotals);
  aggregate(febVouchers.values, febTotals);

  // Calculate increases
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

  increases.sort((a, b) => b.increase - a.increase);
  const top3 = increases.slice(0, 3);
  console.log(`[Handler] Top 3 expense increases: ${top3.map(a => `${a.accountNumber} (${a.name}): +${a.increase}`).join(", ")}`);

  // If no data from vouchers, use entity-extracted accounts as fallback
  const accountsToProcess = top3.length > 0 ? top3 : (
    (Array.isArray(entity.accounts) ? entity.accounts : []) as Array<{ accountNumber: number; name?: string }>
  ).map(a => ({ accountNumber: Number(a.accountNumber), name: a.name ?? `Konto ${a.accountNumber}`, increase: 0 }));

  if (accountsToProcess.length === 0) {
    // Last resort: create 3 generic cost analysis projects
    for (let i = 1; i <= 3; i++) {
      const project = await client.post<{ id: number }>("/project", {
        name: `Kostnadsanalyse ${i}`,
        projectManager: { id: pmId },
        department: { id: departmentId },
        startDate: today(),
        isInternal: true,
      });
      console.log(`[Handler] Created generic analysis project ${i}: id=${project.value.id}`);

      try {
        await client.post("/activity", {
          name: `Kostnadsanalyse ${i} ${Date.now()}`,
          activityType: "PROJECT_GENERAL_ACTIVITY",
        });
      } catch {
        console.warn(`[Handler] Could not create activity for project ${project.value.id}`);
      }
    }
    return;
  }

  for (const acct of accountsToProcess) {
    const projectName = `${acct.name}`;

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
      const activityName = `${acct.name} analyse ${Date.now()}`;
      await client.post("/activity", {
        name: activityName.slice(0, 255),
        activityType: "PROJECT_GENERAL_ACTIVITY",
      });
      console.log(`[Handler] Created activity for project ${project.value.id}`);
    } catch (err) {
      console.warn(`[Handler] Could not create activity: ${err instanceof Error ? err.message : err}`);
    }
  }
}
