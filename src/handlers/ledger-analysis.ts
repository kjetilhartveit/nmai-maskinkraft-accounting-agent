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

  // Parallel: resolve PM + department + query both voucher periods in one call (3 API calls)
  const [pmId, departmentId, allVouchers] = await Promise.all([
    getProjectManagerEmployeeId(client),
    getDefaultDepartmentId(client),
    client.list<Voucher>("/ledger/voucher", {
      dateFrom: "2026-01-01",
      dateTo: "2026-02-28",
      from: "0",
      count: "1000",
    }),
  ]);
  if (!pmId) throw new Error("No employee found to use as project manager");

  // Split vouchers by month client-side
  const janVouchers = allVouchers.values.filter((v) => {
    const d = (v as unknown as { date?: string }).date;
    return d && d < "2026-02-01";
  });
  const febVouchers = allVouchers.values.filter((v) => {
    const d = (v as unknown as { date?: string }).date;
    return d && d >= "2026-02-01";
  });

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

  aggregate(janVouchers, janTotals);
  aggregate(febVouchers, febTotals);

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

  const items = accountsToProcess.length > 0
    ? accountsToProcess.map((a) => a.name.slice(0, 255))
    : [1, 2, 3].map((i) => `Kostnadsanalyse ${i}`);

  // Batch-create projects in one API call (fallback to parallel POSTs if BETA restriction)
  const projectBodies = items.map((name) => ({
    name,
    projectManager: { id: pmId },
    department: { id: departmentId },
    startDate: today(),
    isInternal: true,
  }));

  let projectIds: number[];
  try {
    const batchResult = await client.postList<{ id: number }>("/project/list", projectBodies);
    projectIds = batchResult.values.map((r) => r.id);
    console.log(`[Handler] Batch-created ${projectIds.length} projects`);
  } catch {
    console.log("[Handler] Batch project creation failed, falling back to parallel POSTs");
    const results = await Promise.all(
      projectBodies.map((body) => client.post<{ id: number }>("/project", body)),
    );
    projectIds = results.map((r) => r.value.id);
  }

  for (let i = 0; i < items.length; i++) {
    console.log(`[Handler] Created analysis project: ${items[i]} (id=${projectIds[i]})`);
    if (accountsToProcess.length > 0) {
      ctx.registerProject(accountsToProcess[i].name, projectIds[i]);
    }
  }

  // Batch-create activities in one API call
  try {
    const ts = Date.now();
    await client.postList("/activity/list", items.map((name, i) => ({
      name: `${name} analyse ${ts + i}`.slice(0, 255),
      activityType: "PROJECT_GENERAL_ACTIVITY",
    })));
    console.log(`[Handler] Batch-created ${items.length} activities`);
  } catch (err) {
    console.warn(`[Handler] Could not batch-create activities: ${err instanceof Error ? err.message : err}`);
  }
}
