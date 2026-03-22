import { Hono } from "hono";
import { SolveRequestSchema } from "../types/index.js";
import type { ApiCallLog, ParsedTaskSequence, SolveResponse, TaskType } from "../types/index.js";
import { TripletexClient } from "../lib/tripletex-client.js";
import { executeTaskSequence } from "../handlers/index.js";
import { resetCaches } from "../lib/tripletex-helpers.js";
import { resetPaymentCache } from "../handlers/create-payment.js";
import { resetTravelExpenseCache } from "../handlers/create-travel-expense.js";
import { resetVoucherCache } from "../handlers/create-voucher.js";
import { resetProductCache } from "../handlers/create-product.js";
import { resetPayrollCache } from "../handlers/create-payroll.js";
import { resetSupplierInvoiceCache } from "../handlers/create-supplier-invoice.js";
import { resetDimensionCache } from "../handlers/create-dimension.js";
import { resetGenericHandlerCache } from "../handlers/generic-handler.js";
import { resetYearEndClosingCache } from "../handlers/year-end-closing.js";
import { resetMonthlyClosingCache } from "../handlers/monthly-closing.js";
import { resetLedgerAuditCache } from "../handlers/ledger-audit.js";
import { resetFxPaymentCache } from "../handlers/fx-payment.js";
import { resetReversePaymentCache } from "../handlers/reverse-payment.js";
import { resetReminderFeeCache } from "../handlers/reminder-fee.js";
import { resetBankReconciliationCache } from "../handlers/bank-reconciliation.js";
import { logSolveRequest, logRawRequest } from "../lib/solve-logger.js";
import { config } from "../lib/config.js";
import { createSolveTrace } from "../lib/solve-trace.js";
import { classifyPrompt } from "../lib/task-classifier.js";
import { extractEntities, buildTaskSequence } from "../lib/entity-extractor.js";

export const solveRouter = new Hono();

export interface SolveEvalResponseBody {
  status: "completed";
  success: boolean;
  parsedSequence?: ParsedTaskSequence;
  apiCallStats: {
    total: number;
    errors: number;
    details: ApiCallLog[];
  };
  elapsedMs: number;
  error?: string;
}

function detectSource(evalMode: boolean, baseUrl: string): "competition" | "eval" | "manual" {
  if (evalMode) return "eval";
  const sandboxUrl = config.sandbox.apiUrl;
  if (sandboxUrl && baseUrl === sandboxUrl) return "manual";
  if (baseUrl && baseUrl !== sandboxUrl) return "competition";
  return "manual";
}

solveRouter.post("/solve", async (c) => {
  const start = performance.now();
  const evalMode = c.req.header("X-Eval-Mode") === "true";
  const solveId = `solve-${Date.now()}`;
  const trace = createSolveTrace(solveId);

  let client: TripletexClient | undefined;
  let sequence: ParsedTaskSequence | undefined;
  let prompt = "";
  let filesCount = 0;
  let baseUrl = "";

  // Reset all caches
  resetCaches();
  resetPaymentCache();
  resetTravelExpenseCache();
  resetVoucherCache();
  resetProductCache();
  resetPayrollCache();
  resetSupplierInvoiceCache();
  resetDimensionCache();
  resetGenericHandlerCache();
  resetYearEndClosingCache();
  resetMonthlyClosingCache();
  resetLedgerAuditCache();
  resetFxPaymentCache();
  resetReversePaymentCache();
  resetReminderFeeCache();
  resetBankReconciliationCache();

  try {
    const rawBody = await c.req.json();
    const rawHeaders = Object.fromEntries(
      [...c.req.raw.headers.entries()].filter(([k]) => !k.toLowerCase().includes("authorization")),
    );

    logRawRequest({
      id: solveId,
      timestamp: new Date().toISOString(),
      headers: rawHeaders,
      body: rawBody,
    });

    const parsed = SolveRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
      console.error(`[Solve] ${solveId} | Validation failed: ${issues}`);
      trace.logResult(false, { total: 0, errors: 0 }, `Validation: ${issues}`);

      const source = detectSource(evalMode, rawBody.tripletex_credentials?.base_url ?? "");
      logSolveRequest({
        id: solveId,
        timestamp: new Date().toISOString(),
        prompt: rawBody.prompt ?? "",
        filesCount: Array.isArray(rawBody.files) ? rawBody.files.length : 0,
        baseUrl: rawBody.tripletex_credentials?.base_url ?? "",
        parsedSequence: undefined,
        apiCalls: [],
        apiCallStats: { total: 0, errors: 0, totalDuration: 0 },
        elapsedMs: Math.round(performance.now() - start),
        success: false,
        error: `Validation: ${issues}`,
        source,
      });

      if (evalMode) {
        return c.json({
          status: "completed",
          success: false,
          apiCallStats: { total: 0, errors: 0, details: [] },
          elapsedMs: Math.round(performance.now() - start),
          error: `Validation: ${issues}`,
        } satisfies SolveEvalResponseBody);
      }
      return c.json({ status: "completed" } satisfies SolveResponse);
    }

    const { files, tripletex_credentials } = parsed.data;
    prompt = parsed.data.prompt;
    filesCount = files.length;
    baseUrl = tripletex_credentials.base_url;
    const source = detectSource(evalMode, baseUrl);

    // Log request
    trace.logRequest(prompt, filesCount, baseUrl);

    client = new TripletexClient(
      tripletex_credentials.base_url,
      tripletex_credentials.session_token,
    );

    // ══════════════════════════════════════════════════════════════════
    // STEP 1: Classify the prompt
    // ══════════════════════════════════════════════════════════════════
    let classification;
    try {
      const classifyStart = performance.now();
      classification = await classifyPrompt(prompt);
      const classifyMs = Math.round(performance.now() - classifyStart);

      if (!classification) {
        throw new Error("Classification returned null");
      }
      trace.logClassification(classification.type, classification.method, undefined, classifyMs);
    } catch (classifyError) {
      console.error("[Solve] Classification error:", classifyError);
      throw new Error(`Classification failed: ${classifyError instanceof Error ? classifyError.message : String(classifyError)}`);
    }

    const taskType = classification.type as TaskType;

    // ══════════════════════════════════════════════════════════════════
    // STEP 2: Extract entities based on task type
    // ══════════════════════════════════════════════════════════════════
    let extraction;
    try {
      extraction = await extractEntities(taskType, prompt, files);
      trace.logEntityExtraction(taskType, extraction.entities, extraction.durationMs);
    } catch (extractError) {
      console.error("[Solve] Entity extraction error:", extractError);
      throw new Error(`Entity extraction failed: ${extractError instanceof Error ? extractError.message : String(extractError)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // STEP 3: Build task sequence (with prerequisites)
    // ══════════════════════════════════════════════════════════════════
    const tasks = buildTaskSequence(taskType, extraction, prompt);

    sequence = {
      tasks,
      language: extraction.language,
      rawPrompt: prompt,
    };

    trace.logTaskSequence(
      tasks.map(t => ({ taskType: t.taskType, entities: t.entities })),
      extraction.language,
    );

    // ══════════════════════════════════════════════════════════════════
    // STEP 5: Execute the task sequence
    // ══════════════════════════════════════════════════════════════════
    for (const task of sequence.tasks) {
      trace.logHandlerStart(task.taskType, "dedicated");
    }

    await executeTaskSequence(client, sequence);

    // Log API calls to trace
    for (const call of client.calls) {
      trace.logApiCall(call.method, call.endpoint, call.status, call.durationMs, call.errorBody);
    }

    const elapsed = Math.round(performance.now() - start);
    const stats = client.stats;

    trace.logResult(true, { total: stats.total, errors: stats.errors });

    logSolveRequest({
      id: solveId,
      timestamp: new Date().toISOString(),
      prompt,
      filesCount,
      baseUrl,
      parsedSequence: sequence,
      apiCalls: [...client.calls],
      apiCallStats: stats,
      elapsedMs: elapsed,
      success: true,
      source,
    });

    if (evalMode) {
      return c.json({
        status: "completed",
        success: true,
        parsedSequence: sequence,
        apiCallStats: {
          total: stats.total,
          errors: stats.errors,
          details: [...client.calls],
        },
        elapsedMs: elapsed,
      } satisfies SolveEvalResponseBody);
    }

    return c.json({ status: "completed" } satisfies SolveResponse);

  } catch (error) {
    const elapsed = Math.round(performance.now() - start);
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : "";
    console.error(`[Solve] ${solveId} | Error after ${elapsed}ms:`, message);
    console.error(`[Solve] ${solveId} | Stack trace:`, stack);

    const stats = client?.stats ?? { total: 0, errors: 0, totalDuration: 0 };
    const source = detectSource(evalMode, baseUrl);

    trace.logResult(false, { total: stats.total, errors: stats.errors }, message);

    logSolveRequest({
      id: solveId,
      timestamp: new Date().toISOString(),
      prompt,
      filesCount,
      baseUrl,
      parsedSequence: sequence,
      apiCalls: client ? [...client.calls] : [],
      apiCallStats: stats,
      elapsedMs: elapsed,
      success: false,
      error: message,
      source,
    });

    if (evalMode) {
      return c.json({
        status: "completed",
        success: false,
        parsedSequence: sequence,
        apiCallStats: {
          total: stats.total,
          errors: stats.errors,
          details: client ? [...client.calls] : [],
        },
        elapsedMs: elapsed,
        error: message,
      } satisfies SolveEvalResponseBody, 200);
    }

    return c.json({ status: "completed" } satisfies SolveResponse);
  }
});
