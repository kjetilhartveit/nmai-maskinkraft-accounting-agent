import "dotenv/config";
import type { ParsedTaskSequence } from "../types/index.js";
import db from "../lib/db.js";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";

interface CaptureResult {
  id: string;
  prompt: string;
  timestamp: string;
  model: string;
  parsedSequence?: ParsedTaskSequence;
  apiCalls: {
    total: number;
    errors: number;
    details: Array<{
      method: string;
      endpoint: string;
      status: number;
      durationMs: number;
      isError: boolean;
    }>;
  };
  elapsedMs: number;
  success: boolean;
  error?: string;
}

async function captureRun(
  prompt: string,
  id: string,
): Promise<CaptureResult> {
  const baseUrl = process.env.SANDBOX_API_URL;
  const sessionToken = process.env.SANDBOX_SESSION_TOKEN;

  if (!baseUrl || !sessionToken) {
    throw new Error("Missing SANDBOX_API_URL or SANDBOX_SESSION_TOKEN");
  }

  const res = await fetch(`${SERVER_URL}/solve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Eval-Mode": "true",
    },
    body: JSON.stringify({
      prompt,
      files: [],
      tripletex_credentials: { base_url: baseUrl, session_token: sessionToken },
    }),
  });

  const body = await res.json() as Record<string, unknown>;

  return {
    id,
    prompt,
    timestamp: new Date().toISOString(),
    model: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.6",
    parsedSequence: body.parsedSequence as ParsedTaskSequence | undefined,
    apiCalls: (body.apiCallStats as CaptureResult["apiCalls"]) ?? {
      total: 0,
      errors: 0,
      details: [],
    },
    elapsedMs: (body.elapsedMs as number) ?? 0,
    success: (body.success as boolean) ?? false,
    error: body.error as string | undefined,
  };
}

async function main() {
  const prompt = process.argv.slice(2).filter((a) => a !== "--").join(" ");
  if (!prompt) {
    console.log("Usage: pnpm capture \"<prompt>\"");
    console.log("  Captures the full solve result (parsed task sequence + API calls) for review.");
    console.log("  Results are saved to the database.");
    process.exit(1);
  }

  const id = `capture-${Date.now()}`;
  console.log(`Capturing run for: "${prompt.slice(0, 80)}..."`);

  const result = await captureRun(prompt, id);

  db.prepare(
    `INSERT OR IGNORE INTO captures
     (id, prompt, timestamp, model, parsed_sequence, api_call_total, api_call_errors, api_call_details, elapsed_ms, success, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.id,
    result.prompt,
    result.timestamp,
    result.model,
    result.parsedSequence ? JSON.stringify(result.parsedSequence) : null,
    result.apiCalls.total,
    result.apiCalls.errors,
    JSON.stringify(result.apiCalls.details),
    result.elapsedMs,
    result.success ? 1 : 0,
    result.error ?? null,
  );

  const tasks = result.parsedSequence?.tasks ?? [];
  console.log(`\nResult:`);
  console.log(`  Tasks: ${tasks.length}`);
  for (const t of tasks) {
    console.log(`    - ${t.taskType}: ${JSON.stringify(t.entities)}`);
  }
  console.log(`  Language: ${result.parsedSequence?.language ?? "?"}`);
  console.log(`  API calls: ${result.apiCalls.total} (${result.apiCalls.errors} errors)`);
  console.log(`  Success: ${result.success}`);
  if (result.error) console.log(`  Error: ${result.error}`);
  console.log(`\nSaved to database`);
}

main().catch(console.error);
