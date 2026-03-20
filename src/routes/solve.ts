import { Hono } from "hono";
import { SolveRequestSchema } from "../types/index.js";
import type { ApiCallLog, ParsedTask, SolveResponse } from "../types/index.js";
import { TripletexClient } from "../lib/tripletex-client.js";
import { parsePrompt, type ParsePromptOptions } from "../lib/llm.js";
import { executeTask } from "../handlers/index.js";
import { resetCaches } from "../lib/tripletex-helpers.js";

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
  let client: TripletexClient | undefined;
  let parsedTask: ParsedTask | undefined;

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

    const { prompt, files, tripletex_credentials } = parsed.data;
    console.log(`[Solve] Received prompt (${prompt.length} chars)`);
    console.log(`[Solve] Files: ${files.length}, Base URL: ${tripletex_credentials.base_url}`);

    client = new TripletexClient(
      tripletex_credentials.base_url,
      tripletex_credentials.session_token,
    );

    const parseOpts = evalMode ? evalParseOptions(c) : undefined;
    parsedTask = await parsePrompt(prompt, files, parseOpts);
    console.log(`[Solve] Parsed task: ${parsedTask.taskType} (${parsedTask.language})`);

    await executeTask(client, parsedTask);

    const elapsed = Math.round(performance.now() - start);
    const stats = client.stats;
    console.log(
      `[Solve] Completed in ${elapsed}ms | API calls: ${stats.total} (${stats.errors} errors, ${stats.totalDuration}ms total API time)`,
    );

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
    console.error(`[Solve] Error after ${elapsed}ms:`, error);

    if (evalMode) {
      const message = error instanceof Error ? error.message : String(error);
      const stats = client?.stats ?? { total: 0, errors: 0, totalDuration: 0 };
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
