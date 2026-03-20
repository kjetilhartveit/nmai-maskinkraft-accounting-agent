import type { EvalResult, EvalSummary } from "./types.js";

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s + " ".repeat(w - s.length);
}

function fmtBool(b: boolean): string {
  return b ? "yes" : "no";
}

/** Print one row per test case and a footer summary. */
export function printEvalTable(results: EvalResult[], summary: EvalSummary): void {
  const colId = 22;
  const colOk = 8;
  const colParse = 8;
  const colApi = 6;
  const colErr = 4;
  const colMs = 6;

  const header =
    `${pad("case", colId)} ${pad("pass", colOk)} ${pad("parse", colParse)} ${pad("api", colApi)} ${pad("4xx+", colErr)} ${pad("ms", colMs)} task`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of results) {
    const task = r.parsedTask?.taskType ?? "?";
    const line = `${pad(r.testCaseId, colId)} ${pad(fmtBool(r.success), colOk)} ${pad(fmtBool(r.parseMatch), colParse)} ${pad(String(r.apiCalls.count), colApi)} ${pad(String(r.apiCalls.errors), colErr)} ${pad(String(r.elapsedMs), colMs)} ${task}`;
    console.log(line);
    if (r.error && !r.success) {
      console.log(`  └─ ${r.error.slice(0, 120)}${r.error.length > 120 ? "…" : ""}`);
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
