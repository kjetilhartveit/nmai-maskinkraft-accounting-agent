import { Hono } from "hono";
import { SolveRequestSchema } from "../types/index.js";
import type { SolveResponse } from "../types/index.js";
import { TripletexClient } from "../lib/tripletex-client.js";
import { parsePrompt } from "../lib/llm.js";
import { executeTask } from "../handlers/index.js";

export const solveRouter = new Hono();

solveRouter.post("/solve", async (c) => {
  const start = performance.now();

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

    const client = new TripletexClient(
      tripletex_credentials.base_url,
      tripletex_credentials.session_token,
    );

    const task = await parsePrompt(prompt, files);
    console.log(`[Solve] Parsed task: ${task.taskType} (${task.language})`);

    await executeTask(client, task);

    const elapsed = Math.round(performance.now() - start);
    const stats = client.stats;
    console.log(
      `[Solve] Completed in ${elapsed}ms | API calls: ${stats.total} (${stats.errors} errors, ${stats.totalDuration}ms total API time)`,
    );

    const response: SolveResponse = { status: "completed" };
    return c.json(response);
  } catch (error) {
    const elapsed = Math.round(performance.now() - start);
    console.error(`[Solve] Error after ${elapsed}ms:`, error);
    const response: SolveResponse = { status: "completed" };
    return c.json(response);
  }
});
