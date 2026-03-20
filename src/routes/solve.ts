import { Hono } from "hono";
import { SolveRequestSchema } from "../types/index.js";
import type { ApiCallLog, ParsedTask, SolveResponse } from "../types/index.js";
import { TripletexClient } from "../lib/tripletex-client.js";
import { parsePrompt, type ParsePromptOptions } from "../lib/llm.js";
import { executeTask } from "../handlers/index.js";
import { resetCaches } from "../lib/tripletex-helpers.js";
import { logSolveRequest, type SolveLogEntry } from "../lib/solve-logger.js";

export const solveRouter = new Hono();

export interface SolveEvalResponseBody {
  status: "completed";
  success: boolean;
  parsedTask?: ParsedTask;
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

solveRouter.post("/solve", async (c) => {
  const start = performance.now();
  const evalMode = c.req.header("X-Eval-Mode") === "true";
  const solveId = `solve-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let client: TripletexClient | undefined;
  let parsedTask: ParsedTask | undefined;
  let prompt = "";
  let filesCount = 0;
  let baseUrl = "";

  if (evalMode) {
    resetCaches();
  }

  try {
    const rawBody = await c.req.json();
    const parsed = SolveRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
      console.error("[Solve] Invalid request body:", parsed.error.issues);
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { files, tripletex_credentials } = parsed.data;
    prompt = parsed.data.prompt;
    filesCount = files.length;
    baseUrl = tripletex_credentials.base_url;

    console.log(`[Solve] ${solveId} | Received prompt (${prompt.length} chars)`);
    console.log(`[Solve] ${solveId} | Files: ${filesCount}, Base URL: ${baseUrl}`);

    client = new TripletexClient(
      tripletex_credentials.base_url,
      tripletex_credentials.session_token,
    );

    const parseOpts = evalMode ? evalParseOptions(c) : undefined;
    parsedTask = await parsePrompt(prompt, files, parseOpts);
    console.log(`[Solve] ${solveId} | Parsed task: ${parsedTask.taskType} (${parsedTask.language})`);

    await executeTask(client, parsedTask);

    const elapsed = Math.round(performance.now() - start);
    const stats = client.stats;
    console.log(
      `[Solve] ${solveId} | Completed in ${elapsed}ms | API calls: ${stats.total} (${stats.errors} errors, ${stats.totalDuration}ms total API time)`,
    );

    const source = evalMode ? "eval" as const : (baseUrl.includes("ainm.no") ? "competition" as const : "manual" as const);
    logSolveRequest({
      id: solveId,
      timestamp: new Date().toISOString(),
      prompt,
      filesCount,
      baseUrl,
      parsedTask,
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
        parsedTask,
        apiCallStats: {
          total: stats.total,
          errors: stats.errors,
          details: [...client.calls],
        },
        elapsedMs: elapsed,
      };
      return c.json(body);
    }

    const response: SolveResponse = { status: "completed" };
    return c.json(response);
  } catch (error) {
    const elapsed = Math.round(performance.now() - start);
    console.error(`[Solve] ${solveId} | Error after ${elapsed}ms:`, error);
    const message = error instanceof Error ? error.message : String(error);

    const stats = client?.stats ?? { total: 0, errors: 0, totalDuration: 0 };
    const source = evalMode ? "eval" as const : (baseUrl.includes("ainm.no") ? "competition" as const : "manual" as const);
    logSolveRequest({
      id: solveId,
      timestamp: new Date().toISOString(),
      prompt,
      filesCount,
      baseUrl,
      parsedTask,
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
        parsedTask,
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

    const response: SolveResponse = { status: "completed" };
    return c.json(response);
  }
});
