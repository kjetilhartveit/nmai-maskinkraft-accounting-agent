import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { ApiCallLog, ParsedTask } from "../types/index.js";

const LOGS_DIR = join(import.meta.dirname, "../../data/solve-logs");

export interface SolveLogEntry {
  id: string;
  timestamp: string;
  prompt: string;
  filesCount: number;
  baseUrl: string;
  parsedTask?: ParsedTask;
  apiCalls: ApiCallLog[];
  apiCallStats: { total: number; errors: number; totalDuration: number };
  elapsedMs: number;
  success: boolean;
  error?: string;
  source: "competition" | "eval" | "manual";
}

function ensureLogsDir() {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

export function logSolveRequest(entry: SolveLogEntry): void {
  try {
    ensureLogsDir();

    const logFile = join(LOGS_DIR, "solves.jsonl");
    const line = JSON.stringify(entry) + "\n";
    writeFileSync(logFile, line, { flag: "a" });

    const promptFile = join(LOGS_DIR, "prompts.jsonl");
    const promptEntry = {
      id: entry.id,
      timestamp: entry.timestamp,
      prompt: entry.prompt,
      taskType: entry.parsedTask?.taskType ?? "unknown",
      language: entry.parsedTask?.language ?? "unknown",
      entities: entry.parsedTask?.entities ?? [],
      success: entry.success,
      source: entry.source,
    };
    writeFileSync(promptFile, JSON.stringify(promptEntry) + "\n", { flag: "a" });

    console.log(`[Logger] Saved solve log ${entry.id} → ${logFile}`);
  } catch (err) {
    console.error("[Logger] Failed to write solve log:", err);
  }
}
