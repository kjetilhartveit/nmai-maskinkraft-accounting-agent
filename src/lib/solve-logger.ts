import db from "./db.js";
import type { ApiCallLog, ParsedTaskSequence } from "../types/index.js";

export interface RawRequestLogEntry {
  id: string;
  timestamp: string;
  headers: Record<string, string>;
  body: unknown;
}

export function logRawRequest(entry: RawRequestLogEntry): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO raw_requests (id, timestamp, headers, body)
       VALUES (?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.timestamp,
      JSON.stringify(entry.headers),
      JSON.stringify(entry.body),
    );
  } catch (err) {
    console.error("[Logger] Failed to write raw request log:", err);
  }
}

export interface SolveLogEntry {
  id: string;
  timestamp: string;
  prompt: string;
  filesCount: number;
  baseUrl: string;
  parsedSequence?: ParsedTaskSequence;
  apiCalls: ApiCallLog[];
  apiCallStats: { total: number; errors: number; totalDuration: number };
  elapsedMs: number;
  success: boolean;
  error?: string;
  source: "competition" | "eval" | "manual";
}

export function logSolveRequest(entry: SolveLogEntry): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO solves
       (id, timestamp, prompt, files_count, base_url, parsed_sequence, api_calls,
        api_call_total, api_call_errors, api_call_duration, elapsed_ms, success, error, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.timestamp,
      entry.prompt,
      entry.filesCount,
      entry.baseUrl,
      entry.parsedSequence ? JSON.stringify(entry.parsedSequence) : null,
      JSON.stringify(entry.apiCalls),
      entry.apiCallStats.total,
      entry.apiCallStats.errors,
      entry.apiCallStats.totalDuration,
      entry.elapsedMs,
      entry.success ? 1 : 0,
      entry.error ?? null,
      entry.source,
    );

    console.log(`[Logger] Saved solve log ${entry.id}`);
  } catch (err) {
    console.error("[Logger] Failed to write solve log:", err);
  }
}
