import db from "../lib/db.js";

// Get recent competition solves without scores
const solves = db
  .prepare(
    `SELECT id, timestamp, substr(prompt, 1, 100) as prompt_start, 
            api_call_total, api_call_errors, success, score_earned, score_max,
            json_extract(parsed_sequence, '$.tasks[0].taskType') as task_type
     FROM solves 
     WHERE source = 'competition' 
       AND timestamp > '2026-03-22T04:00:00'
     ORDER BY timestamp ASC`,
  )
  .all() as {
  id: string;
  timestamp: string;
  prompt_start: string;
  api_call_total: number;
  api_call_errors: number;
  success: number;
  score_earned: number | null;
  score_max: number | null;
  task_type: string | null;
}[];

console.log(`Found ${solves.length} competition solves from this session:\n`);

for (const s of solves) {
  const ts = new Date(s.timestamp);
  const cet = new Date(ts.getTime() + 1 * 60 * 60 * 1000); // UTC+1
  const timeStr = cet.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const scoreStr = s.score_earned != null ? `${s.score_earned}/${s.score_max}` : "no score";
  console.log(
    `${timeStr} | ${s.id.replace("solve-", "")} | ${s.task_type?.padEnd(25) ?? "unknown".padEnd(25)} | calls=${s.api_call_total} err=${s.api_call_errors} | ${scoreStr}`,
  );
}

// Now add the scores we observed from the UI.
// Mapping: solve timestamp → (score_earned, score_max, checks_passed, checks_total, checks_detail)
// We match by approximate CET time and task type from the UI.
const scoreUpdates: {
  solveId: string;
  earned: number;
  max: number;
  checksPassed?: number;
  checksTotal?: number;
  checksDetail?: string;
}[] = [];

// Helper to find solve by task_type closest to a given UTC timestamp
function findSolve(taskType: string, approxUtcMs: number, toleranceMs = 120000) {
  return solves.find((s) => {
    if (s.task_type !== taskType) return false;
    const solveMs = new Date(s.timestamp).getTime();
    return Math.abs(solveMs - approxUtcMs) < toleranceMs;
  });
}

// Scores from the competition UI (times are CET = UTC+1):
// 05:07 AM CET = 04:07 UTC → fx_payment → 7/10
const fxPayment = findSolve("fx_payment", Date.parse("2026-03-22T04:07:00Z"));
if (fxPayment) scoreUpdates.push({ solveId: fxPayment.id, earned: 7, max: 10 });

// 05:09 AM CET = 04:09 UTC → create_credit_note → 8/8  
const creditNote1 = findSolve("create_credit_note", Date.parse("2026-03-22T04:09:00Z"));
if (creditNote1) scoreUpdates.push({ solveId: creditNote1.id, earned: 8, max: 8 });

// 05:18 AM CET = 04:18 UTC → create_project → 4.5/10
const createProject1 = findSolve("create_project", Date.parse("2026-03-22T04:18:00Z"));
if (createProject1) scoreUpdates.push({ solveId: createProject1.id, earned: 4.5, max: 10, checksPassed: 3, checksTotal: 6 });

// 05:22 AM CET = 04:22 UTC → create_project → 7/7
const createProject2 = findSolve("create_project", Date.parse("2026-03-22T04:22:00Z"));
if (createProject2) scoreUpdates.push({ solveId: createProject2.id, earned: 7, max: 7 });

// 05:28 AM CET = 04:28 UTC → employee_onboarding_pdf → 0/14
const onboarding1 = findSolve("employee_onboarding_pdf", Date.parse("2026-03-22T04:28:00Z"));
if (onboarding1) scoreUpdates.push({ solveId: onboarding1.id, earned: 0, max: 14 });

// 05:33 AM CET = 04:33 UTC → receipt_expense → 0/10
const receipt1 = findSolve("receipt_expense", Date.parse("2026-03-22T04:33:00Z"));
if (receipt1) scoreUpdates.push({ solveId: receipt1.id, earned: 0, max: 10 });

// 05:37 AM CET = 04:37 UTC → receipt_expense → 0/10
const receipt2 = findSolve("receipt_expense", Date.parse("2026-03-22T04:37:00Z"));
if (receipt2) scoreUpdates.push({ solveId: receipt2.id, earned: 0, max: 10 });

// 05:47 AM CET = 04:47 UTC → employee_onboarding_pdf → 7/14
const onboarding2 = findSolve("employee_onboarding_pdf", Date.parse("2026-03-22T04:47:00Z"));
if (onboarding2) scoreUpdates.push({ solveId: onboarding2.id, earned: 7, max: 14, checksPassed: 5, checksTotal: 10 });

// 05:53 AM CET = 04:53 UTC → create_timesheet → 0/8
const timesheet1 = findSolve("create_timesheet", Date.parse("2026-03-22T04:53:00Z"));
if (timesheet1) scoreUpdates.push({ solveId: timesheet1.id, earned: 0, max: 8 });

// 06:00 AM CET = 05:00 UTC → create_product → 7/7
const product1 = findSolve("create_product", Date.parse("2026-03-22T05:00:00Z"));
if (product1) scoreUpdates.push({ solveId: product1.id, earned: 7, max: 7 });

// 06:02 AM CET = 05:02 UTC → year_end_closing → 6/10
const yearEnd1 = findSolve("year_end_closing", Date.parse("2026-03-22T05:02:00Z"));
if (yearEnd1) scoreUpdates.push({ solveId: yearEnd1.id, earned: 6, max: 10 });

// 06:06 AM CET = 05:06 UTC → create_customer → 8/8
const customer1 = findSolve("create_customer", Date.parse("2026-03-22T05:06:00Z"));
if (customer1) scoreUpdates.push({ solveId: customer1.id, earned: 8, max: 8 });

// 06:08 AM CET = 05:08 UTC → create_payment → 7/7
const payment1 = findSolve("create_payment", Date.parse("2026-03-22T05:08:00Z"));
if (payment1) scoreUpdates.push({ solveId: payment1.id, earned: 7, max: 7 });

// 06:11 AM CET = 05:11 UTC → ledger_analysis → 3/10
const ledger1 = findSolve("ledger_analysis", Date.parse("2026-03-22T05:11:00Z"), 300000);
if (ledger1) scoreUpdates.push({ solveId: ledger1.id, earned: 3, max: 10 });

// 06:22 AM CET = 05:22 UTC → create_invoice → 8/8
const invoice1 = findSolve("create_invoice", Date.parse("2026-03-22T05:22:00Z"));
if (invoice1) scoreUpdates.push({ solveId: invoice1.id, earned: 8, max: 8 });

// 06:24 AM CET = 05:24 UTC → reminder_fee → 7/10
const reminder1 = findSolve("reminder_fee", Date.parse("2026-03-22T05:24:00Z"));
if (reminder1) scoreUpdates.push({ solveId: reminder1.id, earned: 7, max: 10 });

// 06:24 AM CET = 05:24 UTC → create_travel_expense → 5.5/8
const travel1 = findSolve("create_travel_expense", Date.parse("2026-03-22T05:24:00Z"));
if (travel1) scoreUpdates.push({ solveId: travel1.id, earned: 5.5, max: 8, checksPassed: 4, checksTotal: 6 });

// 06:30 AM CET = 05:30 UTC → reminder_fee → 5/10
const reminder2 = findSolve("reminder_fee", Date.parse("2026-03-22T05:30:00Z"));
if (reminder2) scoreUpdates.push({ solveId: reminder2.id, earned: 5, max: 10 });

// 06:37 AM CET = 05:37 UTC → receipt_expense → 0/10
const receipt3 = findSolve("receipt_expense", Date.parse("2026-03-22T05:37:00Z"));
if (receipt3) scoreUpdates.push({ solveId: receipt3.id, earned: 0, max: 10 });

// 06:43 AM CET = 05:43 UTC → supplier_invoice_pdf → 2/10
const supplier1 = findSolve("supplier_invoice_pdf", Date.parse("2026-03-22T05:43:00Z"), 300000);
if (supplier1) scoreUpdates.push({ solveId: supplier1.id, earned: 2, max: 10, checksPassed: 1, checksTotal: 6 });

// 06:49 AM CET = 05:49 UTC → project_lifecycle → 6/11
const lifecycle1 = findSolve("project_lifecycle", Date.parse("2026-03-22T05:49:00Z"), 300000);
if (lifecycle1) scoreUpdates.push({ solveId: lifecycle1.id, earned: 6, max: 11, checksPassed: 4, checksTotal: 7 });

// 06:53 AM CET = 05:53 UTC → create_timesheet → 0/8
const timesheet2 = findSolve("create_timesheet", Date.parse("2026-03-22T05:53:00Z"), 300000);
if (timesheet2) scoreUpdates.push({ solveId: timesheet2.id, earned: 0, max: 8 });

// 06:56 AM CET = 05:56 UTC → send_invoice → 7/7
const sendInvoice1 = findSolve("send_invoice", Date.parse("2026-03-22T05:56:00Z"));
if (sendInvoice1) scoreUpdates.push({ solveId: sendInvoice1.id, earned: 7, max: 7 });

// 06:59 AM CET = 05:59 UTC → create_supplier_invoice → 0/8
const supplierInv = findSolve("create_supplier_invoice", Date.parse("2026-03-22T05:59:00Z"), 300000);
if (supplierInv) scoreUpdates.push({ solveId: supplierInv.id, earned: 0, max: 8 });

// 07:07 AM CET = 06:07 UTC → create_credit_note → 8/8
const creditNote2 = findSolve("create_credit_note", Date.parse("2026-03-22T06:07:00Z"));
if (creditNote2) scoreUpdates.push({ solveId: creditNote2.id, earned: 8, max: 8 });

// 07:15 AM CET = 06:15 UTC → employee_onboarding_pdf → 5/14
const onboarding3 = findSolve("employee_onboarding_pdf", Date.parse("2026-03-22T06:15:00Z"), 300000);
if (onboarding3) scoreUpdates.push({ solveId: onboarding3.id, earned: 5, max: 14, checksPassed: 4, checksTotal: 10 });

// 07:19 AM CET = 06:19 UTC → create_timesheet → 0/8
const timesheet3 = findSolve("create_timesheet", Date.parse("2026-03-22T06:19:00Z"));
if (timesheet3) scoreUpdates.push({ solveId: timesheet3.id, earned: 0, max: 8 });

// 07:22 AM CET = 06:22 UTC → create_dimension → 13/13
const dimension1 = findSolve("create_dimension", Date.parse("2026-03-22T06:22:00Z"));
if (dimension1) scoreUpdates.push({ solveId: dimension1.id, earned: 13, max: 13 });

// 07:25 AM CET = 06:25 UTC → supplier_invoice_pdf → 2/10
const supplier2 = findSolve("supplier_invoice_pdf", Date.parse("2026-03-22T06:25:00Z"), 300000);
if (supplier2) scoreUpdates.push({ solveId: supplier2.id, earned: 2, max: 10, checksPassed: 1, checksTotal: 6 });

// 07:32 AM CET = 06:32 UTC → create_payroll → 0/8
const payroll1 = findSolve("create_payroll", Date.parse("2026-03-22T06:32:00Z"), 300000);
if (payroll1) scoreUpdates.push({ solveId: payroll1.id, earned: 0, max: 8 });

// 07:42 AM CET = 06:42 UTC → bank_reconciliation → 0/10
const bank1 = findSolve("bank_reconciliation", Date.parse("2026-03-22T06:42:00Z"), 300000);
if (bank1) scoreUpdates.push({ solveId: bank1.id, earned: 0, max: 10 });

// 07:44 AM CET = 06:44 UTC → create_product → 7/7
const product2 = findSolve("create_product", Date.parse("2026-03-22T06:44:00Z"));
if (product2) scoreUpdates.push({ solveId: product2.id, earned: 7, max: 7 });

// 07:47 AM CET = 06:47 UTC → create_dimension → 13/13
const dimension2 = findSolve("create_dimension", Date.parse("2026-03-22T06:47:00Z"));
if (dimension2) scoreUpdates.push({ solveId: dimension2.id, earned: 13, max: 13 });

// 07:49 AM CET = 06:49 UTC → project_lifecycle → 6/11
const lifecycle2 = findSolve("project_lifecycle", Date.parse("2026-03-22T06:50:00Z"));
if (lifecycle2) scoreUpdates.push({ solveId: lifecycle2.id, earned: 6, max: 11, checksPassed: 4, checksTotal: 7 });

// 07:55 AM CET = 06:55 UTC → create_payroll → 0/8
const payroll2 = findSolve("create_payroll", Date.parse("2026-03-22T06:56:00Z"));
if (payroll2) scoreUpdates.push({ solveId: payroll2.id, earned: 0, max: 8 });

// 08:01 AM CET = 07:01 UTC → reminder_fee → 5/10
const reminder3 = findSolve("reminder_fee", Date.parse("2026-03-22T07:01:00Z"), 300000);
if (reminder3) scoreUpdates.push({ solveId: reminder3.id, earned: 5, max: 10 });

// 08:03 AM CET = 07:03 UTC → employee_onboarding_pdf → 7/14
const onboarding4 = findSolve("employee_onboarding_pdf", Date.parse("2026-03-22T07:03:00Z"), 300000);
if (onboarding4) scoreUpdates.push({ solveId: onboarding4.id, earned: 7, max: 14, checksPassed: 5, checksTotal: 10 });

// Apply updates
const updateStmt = db.prepare(
  `UPDATE solves SET score_earned = ?, score_max = ?, checks_passed = ?, checks_total = ? WHERE id = ?`,
);

let updated = 0;
for (const u of scoreUpdates) {
  const result = updateStmt.run(
    u.earned,
    u.max,
    u.checksPassed ?? null,
    u.checksTotal ?? null,
    u.solveId,
  );
  if (result.changes > 0) {
    updated++;
    console.log(`  Updated ${u.solveId}: ${u.earned}/${u.max}`);
  } else {
    console.log(`  MISSED ${u.solveId}: not found in DB`);
  }
}

console.log(`\nUpdated ${updated}/${scoreUpdates.length} scores.`);

// Also update classified_type from parsed_sequence for all competition solves
const typeUpdate = db.prepare(
  `UPDATE solves SET classified_type = json_extract(parsed_sequence, '$.tasks[0].taskType')
   WHERE source = 'competition' AND classified_type IS NULL AND parsed_sequence IS NOT NULL`,
);
const typeResult = typeUpdate.run();
console.log(`Updated classified_type for ${typeResult.changes} solves.`);

// Show best scores per task type
const best = db
  .prepare(
    `SELECT classified_type as type, 
         MAX(score_earned) as best_earned, 
         MAX(score_max) as max_possible,
         COUNT(*) as attempts,
         ROUND(MAX(score_earned) * 100.0 / MAX(score_max), 0) as best_pct
  FROM solves 
  WHERE source = 'competition' 
    AND score_earned IS NOT NULL
    AND classified_type IS NOT NULL
  GROUP BY classified_type
  ORDER BY best_pct DESC, type`,
  )
  .all() as { type: string; best_earned: number; max_possible: number; attempts: number; best_pct: number }[];

console.log("\nBest score per task type (all-time):");
console.log("Type                      | Best    | Pct  | Attempts");
console.log("-".repeat(60));
for (const s of best) {
  const type = String(s.type || "unknown").padEnd(25);
  const score = (s.best_earned + "/" + s.max_possible).padEnd(7);
  const pct = (s.best_pct + "%").padEnd(5);
  console.log(type + " | " + score + " | " + pct + " | " + s.attempts);
}

const total = db
  .prepare(
    `SELECT COUNT(*) as cnt, SUM(score_earned) as total_earned, SUM(score_max) as total_max
  FROM solves WHERE source = 'competition' AND score_earned IS NOT NULL`,
  )
  .get() as { cnt: number; total_earned: number; total_max: number };
console.log(
  "\nTotal: " + total.cnt + " scored solves, " + total.total_earned + "/" + total.total_max + " points",
);
