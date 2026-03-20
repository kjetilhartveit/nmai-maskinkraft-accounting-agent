import "dotenv/config";
import type { ParsedTask } from "../types/index.js";
import type { SolveEvalResponseBody } from "../routes/solve.js";
import { config } from "../lib/config.js";
import type { EvalConfig, EvalResult, EvalSummary, TestCase } from "./types.js";
import {
  apiBoundsSatisfied,
  entitiesMatch,
  languageMatches,
  taskTypeMatches,
} from "./match.js";

const DEFAULT_SERVER = process.env.SERVER_URL || "http://localhost:3000";

function getCredentials(): { base_url: string; session_token: string } {
  const base_url = process.env.SANDBOX_API_URL || config.sandbox.apiUrl;
  const session_token = process.env.SANDBOX_SESSION_TOKEN || config.sandbox.sessionToken;
  if (!base_url || !session_token) {
    throw new Error(
      "Missing SANDBOX_API_URL / SANDBOX_SESSION_TOKEN (or config.sandbox) for eval requests",
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

export async function runEvalCase(
  serverUrl: string,
  evalConfig: EvalConfig,
  tc: TestCase,
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
  const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/solve`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: tc.prompt,
      files: [],
      tripletex_credentials: creds,
    }),
  });

  const elapsedRoundtrip = Math.round(performance.now() - start);
  const json: unknown = await res.json();

  if (!isEvalBody(json)) {
    return {
      testCaseId: tc.id,
      config: evalConfig,
      apiCalls: { count: 0, errors: 0 },
      elapsedMs: elapsedRoundtrip,
      success: false,
      serverReportedSuccess: false,
      parseMatch: false,
      error: `Unexpected response (${res.status}): ${JSON.stringify(json).slice(0, 200)}`,
    };
  }

  const parsedTask = json.parsedTask as ParsedTask | undefined;
  const total = json.apiCallStats.total;
  const errors = json.apiCallStats.errors;

  const parseMatch =
    taskTypeMatches(tc, parsedTask) &&
    languageMatches(tc, parsedTask) &&
    !!parsedTask &&
    entitiesMatch(
      parsedTask.entities as Record<string, unknown>[],
      tc.expectedEntities,
    );

  const boundsOk = apiBoundsSatisfied(tc, total, errors);
  const success =
    json.success === true && parseMatch && boundsOk && res.ok;

  return {
    testCaseId: tc.id,
    config: evalConfig,
    parsedTask,
    apiCalls: { count: total, errors },
    elapsedMs: json.elapsedMs ?? elapsedRoundtrip,
    success,
    serverReportedSuccess: json.success,
    parseMatch,
    error: json.error,
  };
}

export async function runEval(
  evalConfig: EvalConfig,
  cases: TestCase[],
  options?: { serverUrl?: string },
): Promise<EvalResult[]> {
  const serverUrl = options?.serverUrl ?? DEFAULT_SERVER;
  const results: EvalResult[] = [];
  for (const tc of cases) {
    results.push(await runEvalCase(serverUrl, evalConfig, tc));
  }
  return results;
}

export function summarize(results: EvalResult[]): EvalSummary {
  const first = results[0];
  if (!first) {
    throw new Error("No results to summarize");
  }
  const config = first.config;
  const passed = results.filter((r) => r.success).length;
  const totalElapsed = results.reduce((s, r) => s + r.elapsedMs, 0);
  const totalApi = results.reduce((s, r) => s + r.apiCalls.count, 0);
  const totalErr = results.reduce((s, r) => s + r.apiCalls.errors, 0);
  return {
    config,
    totalCases: results.length,
    passed,
    failed: results.length - passed,
    avgElapsedMs: Math.round(totalElapsed / results.length),
    totalApiCalls: totalApi,
    totalApiErrors: totalErr,
  };
}
