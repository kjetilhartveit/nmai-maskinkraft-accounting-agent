import type { EvalResult, EvalSummary, TestCase } from "./types.js";

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s + " ".repeat(w - s.length);
}

function fmtBool(b: boolean): string {
  return b ? "yes" : "no";
}

/** Print one row per test case and a footer summary. */
export function printEvalTable(results: EvalResult[], summary: EvalSummary): void {
  const colId = 26;
  const colOk = 8;
  const colParse = 8;
  const colApi = 6;
  const colErr = 4;
  const colMs = 6;

  const header =
    `${pad("case", colId)} ${pad("pass", colOk)} ${pad("parse", colParse)} ${pad("api", colApi)} ${pad("4xx+", colErr)} ${pad("ms", colMs)} tasks`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of results) {
    const taskTypes = r.parsedSequence?.tasks.map((t) => t.taskType).join("→") ?? "?";
    const line = `${pad(r.testCaseId, colId)} ${pad(fmtBool(r.success), colOk)} ${pad(fmtBool(r.parseMatch), colParse)} ${pad(String(r.apiCalls.count), colApi)} ${pad(String(r.apiCalls.errors), colErr)} ${pad(String(r.elapsedMs), colMs)} ${taskTypes}`;
    console.log(line);
    if (r.error && !r.success) {
      console.log(`  └─ ${r.error}`);
    }
  }

  console.log("-".repeat(header.length));
  const cfg = summary.config;
  const label =
    cfg.description ??
    `${cfg.model}${cfg.systemPromptVariant ? ` [${cfg.systemPromptVariant}]` : ""}`;
  console.log(`Config: ${label}`);
  console.log(
    `Summary: ${summary.passed}/${summary.totalCases} passed | avg ${summary.avgElapsedMs}ms | Tripletex calls ${summary.totalApiCalls} (${summary.totalApiErrors} error responses)`,
  );
}

export interface BaselineImprovement {
  testCaseId: string;
  oldMax: number;
  newMax: number;
  actualCalls: number;
}

/**
 * Check if any successful results used fewer API calls than the test case allows.
 * Returns suggestions for tightening API call bounds.
 */
export function findBaselineImprovements(
  results: EvalResult[],
  testCases: TestCase[],
): BaselineImprovement[] {
  const improvements: BaselineImprovement[] = [];
  const caseMap = new Map(testCases.map(tc => [tc.id, tc]));

  for (const r of results) {
    if (!r.success || r.apiCalls.errors > 0) continue;
    const tc = caseMap.get(r.testCaseId);
    if (!tc?.expectedApiCalls?.max) continue;

    if (r.apiCalls.count < tc.expectedApiCalls.max) {
      improvements.push({
        testCaseId: r.testCaseId,
        oldMax: tc.expectedApiCalls.max,
        newMax: r.apiCalls.count,
        actualCalls: r.apiCalls.count,
      });
    }
  }

  return improvements;
}

export function printBaselineImprovements(improvements: BaselineImprovement[]): void {
  if (improvements.length === 0) return;

  console.log(`\n${"=".repeat(60)}`);
  console.log("BASELINE IMPROVEMENTS DETECTED");
  console.log(`${"=".repeat(60)}`);
  console.log("These test cases passed with fewer API calls than the current max:\n");

  for (const imp of improvements) {
    console.log(`  ${imp.testCaseId}: ${imp.oldMax} → ${imp.newMax} (used ${imp.actualCalls} calls)`);
  }
  console.log(`\nRun with --update-baselines to apply these improvements.`);
}
