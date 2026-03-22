import type { EvalResult, EvalSummary, TestCase } from "./types.js";

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s + " ".repeat(w - s.length);
}

function fmtBool(b: boolean): string {
  return b ? "yes" : "no";
}

export function printEvalTable(
  results: EvalResult[],
  summary: EvalSummary,
  verbose = false
): void {
  const colId = 36;
  const colOk = 8;
  const colParse = 8;
  const colVerify = 8;
  const colApi = 6;
  const colErr = 4;
  const colMs = 6;

  const header = `${pad("case", colId)} ${pad("pass", colOk)} ${pad("type", colParse)} ${pad("verify", colVerify)} ${pad("write", colApi)} ${pad("err", colErr)} ${pad("ms", colMs)} tasks`;
  console.log(header);
  console.log("-".repeat(header.length + 20));

  for (const r of results) {
    const taskTypes =
      r.parsedSequence?.tasks.map((t) => t.taskType).join("→") ?? "?";
    const passColor = r.success ? "\x1b[32m" : "\x1b[31m";
    const verifyColor = r.sandboxVerified ? "" : "\x1b[31m";
    const verifyReset = r.sandboxVerified ? "" : "\x1b[0m";
    const line = `${pad(r.testCaseId, colId)} ${passColor}${pad(
      fmtBool(r.success),
      colOk
    )}\x1b[0m ${pad(fmtBool(r.parseMatch), colParse)} ${verifyColor}${pad(
      fmtBool(r.sandboxVerified),
      colVerify
    )}${verifyReset} ${pad(
      String(r.apiCalls.writeCalls),
      colApi
    )} ${pad(String(r.apiCalls.writeErrors), colErr)} ${pad(
      String(r.elapsedMs),
      colMs
    )} ${taskTypes}`;
    console.log(line);
    if (r.error && !r.success) {
      console.log(`  └─ ${r.error}`);
    }
    if (!r.sandboxVerified && r.sandboxFailures.length > 0) {
      console.log(`  └─ \x1b[33msandbox: ${r.sandboxFailures.join(", ")}\x1b[0m`);
    }

    if (verbose || (!r.success && r.apiCallDetails.length > 0)) {
      printApiCallDetails(r);
    }
  }

  console.log("-".repeat(header.length + 20));
  const cfg = summary.config;
  const label =
    cfg.description ??
    `${cfg.model}${
      cfg.systemPromptVariant ? ` [${cfg.systemPromptVariant}]` : ""
    }`;
  console.log(`Config: ${label}`);
  console.log(
    `Summary: ${summary.passed}/${summary.totalCases} passed | avg ${summary.avgElapsedMs}ms | Tripletex calls ${summary.totalApiCalls} (${summary.totalApiErrors} error responses)`
  );
}

function printApiCallDetails(r: EvalResult): void {
  if (r.apiCallDetails.length === 0) return;

  for (const call of r.apiCallDetails) {
    const statusColor = call.isError ? "\x1b[31m" : "\x1b[90m";
    const icon = call.isError ? "✗" : "·";
    const errSuffix = call.errorBody ? ` — ${call.errorBody}` : "";
    console.log(
      `  ${icon} ${statusColor}${call.method} ${call.endpoint} → ${call.status} (${call.durationMs}ms)${errSuffix}\x1b[0m`
    );
  }
}

export interface BaselineImprovement {
  testCaseId: string;
  oldMax: number;
  newMax: number;
  actualCalls: number;
}

export function findBaselineImprovements(
  results: EvalResult[],
  testCases: TestCase[]
): BaselineImprovement[] {
  const improvements: BaselineImprovement[] = [];
  const caseMap = new Map(testCases.map((tc) => [tc.id, tc]));

  for (const r of results) {
    if (!r.success || r.apiCalls.writeErrors > 0) continue;
    const tc = caseMap.get(r.testCaseId);
    if (!tc?.expectedApiCalls?.max) continue;

    if (r.apiCalls.writeCalls < tc.expectedApiCalls.max) {
      improvements.push({
        testCaseId: r.testCaseId,
        oldMax: tc.expectedApiCalls.max,
        newMax: r.apiCalls.writeCalls,
        actualCalls: r.apiCalls.writeCalls,
      });
    }
  }

  return improvements;
}

export function printBaselineImprovements(
  improvements: BaselineImprovement[]
): void {
  if (improvements.length === 0) return;

  console.log(`\n${"=".repeat(60)}`);
  console.log("BASELINE IMPROVEMENTS DETECTED");
  console.log(`${"=".repeat(60)}`);
  console.log(
    "These test cases passed with fewer API calls than the current max:\n"
  );

  for (const imp of improvements) {
    console.log(
      `  ${imp.testCaseId}: ${imp.oldMax} → ${imp.newMax} (used ${imp.actualCalls} calls)`
    );
  }
  console.log(`\nRun with --update-baselines to apply these improvements.`);
}
