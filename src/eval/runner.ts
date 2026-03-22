import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import type { ApiCallLog, ParsedTaskSequence } from "../types/index.js";
import type { SolveEvalResponseBody } from "../routes/solve.js";
import { config } from "../lib/config.js";
import { TripletexClient } from "../lib/tripletex-client.js";
import type { EvalConfig, EvalResult, EvalSummary, TestCase } from "./types.js";
import { apiBoundsSatisfied, taskTypeMatches } from "./match.js";
import { verifySandboxEntities } from "./sandbox-verify.js";

const DEFAULT_SERVER = process.env.SERVER_URL || "http://localhost:3000";

function getCredentials(): { base_url: string; session_token: string } {
  const base_url = process.env.SANDBOX_API_URL || config.sandbox.apiUrl;
  const session_token =
    process.env.SANDBOX_SESSION_TOKEN || config.sandbox.sessionToken;
  if (!base_url || !session_token) {
    throw new Error(
      "Missing SANDBOX_API_URL / SANDBOX_SESSION_TOKEN (or config.sandbox) for eval requests"
    );
  }
  return { base_url, session_token };
}

function isEvalBody(x: unknown): x is SolveEvalResponseBody {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o.status === "completed" &&
    typeof o.success === "boolean" &&
    o.apiCallStats !== undefined &&
    typeof o.elapsedMs === "number"
  );
}

function makeFailResult(
  tc: TestCase,
  evalConfig: EvalConfig,
  elapsedMs: number,
  error: string
): EvalResult {
  return {
    testCaseId: tc.id,
    config: evalConfig,
    apiCalls: { count: 0, errors: 0, writeCalls: 0, writeErrors: 0 },
    apiCallDetails: [],
    elapsedMs,
    success: false,
    serverReportedSuccess: false,
    parseMatch: false,
    sandboxVerified: false,
    sandboxFailures: [],
    error,
  };
}

export async function runEvalCase(
  serverUrl: string,
  evalConfig: EvalConfig,
  tc: TestCase
): Promise<EvalResult> {
  const creds = getCredentials();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Eval-Mode": "true",
    "X-Eval-Model": evalConfig.model,
  };
  if (evalConfig.systemPromptVariant) {
    headers["X-Eval-System-Prompt-Variant"] = evalConfig.systemPromptVariant;
  }

  const start = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);

  const files = [];
  if (tc.requiresFile && tc.fileType === "pdf") {
    let filename = "";
    if (tc.taskType === "employee_onboarding_pdf") filename = "onboarding.pdf";
    else if (tc.taskType === "employee_contract_pdf") filename = "contract.pdf";
    else if (tc.taskType === "supplier_invoice_pdf")
      filename = "supplier_invoice.pdf";
    else filename = `${tc.taskType}.pdf`;

    const filepath = path.join(process.cwd(), "data", "pdf", filename);
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath).toString("base64");
      files.push({
        filename,
        content_base64: content,
        mime_type: "application/pdf",
      });
    } else {
      console.warn(
        `[Eval] Missing required file fixture for ${tc.id} at ${filepath}`
      );
    }
  } else if (tc.requiresFile && tc.fileType === "csv") {
    let filename = "";
    if (tc.taskType === "bank_reconciliation") filename = "bank-statement.csv";
    else filename = `${tc.taskType}.csv`;

    const filepath = path.join(process.cwd(), "data", "csv", filename);
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath).toString("base64");
      files.push({
        filename,
        content_base64: content,
        mime_type: "text/csv",
      });
    } else {
      console.warn(
        `[Eval] Missing required file fixture for ${tc.id} at ${filepath}`
      );
    }
  }

  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, "")}/solve`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        prompt: tc.prompt,
        files,
        tripletex_credentials: creds,
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    const elapsed = Math.round(performance.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    return makeFailResult(
      tc,
      evalConfig,
      elapsed,
      `Fetch failed (timeout/network): ${msg}`
    );
  } finally {
    clearTimeout(timeout);
  }

  const elapsedRoundtrip = Math.round(performance.now() - start);
  const responseText = await res.text();

  let json: unknown;
  try {
    json = JSON.parse(responseText);
  } catch {
    return makeFailResult(
      tc,
      evalConfig,
      elapsedRoundtrip,
      `Server returned non-JSON (${res.status}): ${responseText.slice(0, 200)}`
    );
  }

  if (!isEvalBody(json)) {
    return makeFailResult(
      tc,
      evalConfig,
      elapsedRoundtrip,
      `Unexpected response (${res.status}): ${JSON.stringify(json)}`
    );
  }

  const parsedSequence = json.parsedSequence as ParsedTaskSequence | undefined;
  const total = json.apiCallStats.total;
  const errors = json.apiCallStats.errors;
  const writeCalls = json.apiCallStats.writeCalls ?? total; // fallback for backwards compat
  const writeErrors = json.apiCallStats.writeErrors ?? errors;
  const details = (json.apiCallStats.details ?? []) as ApiCallLog[];

  const parseMatch = taskTypeMatches(tc, parsedSequence);
  // Only count write operations (POST/PUT/DELETE) for efficiency bounds - GET calls are free
  const boundsOk = apiBoundsSatisfied(tc, writeCalls, writeErrors);

  // Sandbox verification: check that expected entities were created
  let sandboxVerified = true;
  let sandboxFailures: string[] = [];
  if (tc.expectedEntities.length > 0 && res.ok) {
    try {
      const verifyClient = new TripletexClient(
        creds.base_url,
        creds.session_token
      );
      const verification = await verifySandboxEntities(
        verifyClient,
        tc.expectedEntities,
        details
      );
      sandboxVerified = verification.verified;
      sandboxFailures = verification.failures;
    } catch (err) {
      console.warn(
        `[Eval] ${tc.id}: sandbox verification error: ${
          err instanceof Error ? err.message : err
        }`
      );
      sandboxVerified = false;
      sandboxFailures = ["verification query failed"];
    }
  }

  const success = parseMatch && boundsOk && sandboxVerified && res.ok;

  if (!success && !parseMatch) {
    const actualTypes =
      parsedSequence?.tasks.map((t) => t.taskType).join("→") ?? "none";
    console.warn(
      `[Eval] ${tc.id}: taskType mismatch (expected=${tc.taskType}, got=${actualTypes})`
    );
  }
  if (!success && !sandboxVerified) {
    console.warn(
      `[Eval] ${tc.id}: sandbox verification failed: ${sandboxFailures.join(
        ", "
      )}`
    );
  }

  const errorCalls = details.filter((d) => d.isError);
  if (errorCalls.length > 0) {
    for (const ec of errorCalls) {
      console.warn(
        `[Eval] ${tc.id}: API error ${ec.method} ${ec.endpoint} → ${ec.status}${
          ec.errorBody ? `: ${ec.errorBody.slice(0, 100)}` : ""
        }`
      );
    }
  }

  return {
    testCaseId: tc.id,
    config: evalConfig,
    parsedSequence,
    apiCalls: { count: total, errors, writeCalls, writeErrors },
    apiCallDetails: details,
    elapsedMs: json.elapsedMs ?? elapsedRoundtrip,
    success,
    serverReportedSuccess: json.success,
    parseMatch,
    sandboxVerified,
    sandboxFailures,
    error: json.error,
  };
}

export async function runEval(
  evalConfig: EvalConfig,
  cases: TestCase[],
  options?: {
    serverUrl?: string;
    iterations?: number;
    onResult?: (result: EvalResult, index: number, total: number) => void;
  }
): Promise<EvalResult[]> {
  const serverUrl = options?.serverUrl ?? DEFAULT_SERVER;
  const iterations = options?.iterations ?? 1;
  const results: EvalResult[] = [];
  const total = cases.length * iterations;

  for (let iter = 0; iter < iterations; iter++) {
    if (iterations > 1) {
      console.log(`\n--- Iteration ${iter + 1}/${iterations} ---`);
    }
    for (const tc of cases) {
      const result = await runEvalCase(serverUrl, evalConfig, tc);
      results.push(result);
      options?.onResult?.(result, results.length, total);
    }
  }

  return results;
}

export function summarize(results: EvalResult[]): EvalSummary {
  const first = results[0];
  if (!first) {
    throw new Error("No results to summarize");
  }
  const cfg = first.config;
  const passed = results.filter((r) => r.success).length;
  const totalElapsed = results.reduce((s, r) => s + r.elapsedMs, 0);
  const totalApi = results.reduce((s, r) => s + r.apiCalls.count, 0);
  const totalErr = results.reduce((s, r) => s + r.apiCalls.errors, 0);
  return {
    config: cfg,
    totalCases: results.length,
    passed,
    failed: results.length - passed,
    avgElapsedMs: Math.round(totalElapsed / results.length),
    totalApiCalls: totalApi,
    totalApiErrors: totalErr,
  };
}
