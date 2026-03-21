import { Hono } from "hono";
import { SolveRequestSchema } from "../types/index.js";
import type { ApiCallLog, ParsedTaskSequence, SolveResponse } from "../types/index.js";
import { TripletexClient } from "../lib/tripletex-client.js";
import { parsePrompt, type ParsePromptOptions } from "../lib/llm.js";
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
import { logSolveRequest, logRawRequest, type SolveLogEntry } from "../lib/solve-logger.js";
import { config } from "../lib/config.js";

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

function evalParseOptions(c: { req: { header: (name: string) => string | undefined } }): ParsePromptOptions {
  const model = c.req.header("X-Eval-Model");
  const systemPromptVariant = c.req.header("X-Eval-System-Prompt-Variant");
  return {
    ...(model ? { model } : {}),
    ...(systemPromptVariant ? { systemPromptVariant } : {}),
  };
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
  let client: TripletexClient | undefined;
  let sequence: ParsedTaskSequence | undefined;
  let prompt = "";
  let filesCount = 0;
  let baseUrl = "";

  resetCaches();
  resetPaymentCache();
  resetTravelExpenseCache();
  resetVoucherCache();
  resetProductCache();
  resetPayrollCache();
  resetSupplierInvoiceCache();
  resetDimensionCache();
  resetGenericHandlerCache();

  try {
    const rawBody = await c.req.json();
    const rawHeaders = Object.fromEntries(
      [...c.req.raw.headers.entries()].filter(([k]) => !k.toLowerCase().includes("authorization")),
    );

    console.log(`[Solve] ${solveId} | === INCOMING REQUEST ===`);
    console.log(`[Solve] ${solveId} | Headers: ${JSON.stringify(rawHeaders)}`);
    console.log(`[Solve] ${solveId} | Raw body keys: ${Object.keys(rawBody).join(", ")}`);
    console.log(`[Solve] ${solveId} | prompt length: ${rawBody.prompt?.length ?? "missing"}, files type: ${rawBody.files === null ? "null" : Array.isArray(rawBody.files) ? `array(${rawBody.files.length})` : typeof rawBody.files}, creds: ${rawBody.tripletex_credentials ? "present" : "missing"}`);
    console.log(`[Solve] ${solveId} | Full prompt: ${JSON.stringify(rawBody.prompt)}`);
    console.log(`[Solve] ${solveId} | Base URL: ${rawBody.tripletex_credentials?.base_url ?? "missing"}`);

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
    console.log(`[Solve] ${solveId} | Received prompt (${prompt.length} chars) [${source}]`);
    console.log(`[Solve] ${solveId} | Files: ${filesCount}, Base URL: ${baseUrl}`);

    client = new TripletexClient(
      tripletex_credentials.base_url,
      tripletex_credentials.session_token,
    );

    const parseOpts = evalMode ? evalParseOptions(c) : undefined;
    sequence = await parsePrompt(prompt, files, parseOpts);
    const taskTypes = sequence.tasks.map((t) => t.taskType).join(" → ");
    console.log(`[Solve] ${solveId} | Parsed ${sequence.tasks.length} task(s): ${taskTypes} (${sequence.language})`);

    await executeTaskSequence(client, sequence);

    const elapsed = Math.round(performance.now() - start);
    const stats = client.stats;
    console.log(
      `[Solve] ${solveId} | Completed in ${elapsed}ms | API calls: ${stats.total} (${stats.errors} errors, ${stats.totalDuration}ms total API time)`,
    );

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
      const body: SolveEvalResponseBody = {
        status: "completed",
        success: true,
        parsedSequence: sequence,
        apiCallStats: {
          total: stats.total,
          errors: stats.errors,
          details: [...client.calls],
        },
        elapsedMs: elapsed,
      };
      return c.json(body);
    }

    return c.json({ status: "completed" } satisfies SolveResponse);
  } catch (error) {
    const elapsed = Math.round(performance.now() - start);
    console.error(`[Solve] ${solveId} | Error after ${elapsed}ms:`, error);
    const message = error instanceof Error ? error.message : String(error);

    const stats = client?.stats ?? { total: 0, errors: 0, totalDuration: 0 };
    const source = detectSource(evalMode, baseUrl);
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
      const body: SolveEvalResponseBody = {
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
      };
      return c.json(body, 200);
    }

    return c.json({ status: "completed" } satisfies SolveResponse);
  }
});
