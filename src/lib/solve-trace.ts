/**
 * Solve Trace — Comprehensive logging for the solve pipeline.
 *
 * Writes detailed logs to files (logs/solve-{id}/) and concise output to terminal.
 * Tracks: classification, entity extraction, reasoning, decisions, execution, results.
 */

import { mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { ApiCallLog } from "../types/index.js";

const LOGS_DIR = join(import.meta.dirname, "../../logs");

export interface TraceStep {
  phase: string;
  timestamp: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  model?: string;
  error?: string;
}

export class SolveTrace {
  readonly id: string;
  readonly dir: string;
  private steps: TraceStep[] = [];
  private startTime: number;
  private apiCallsRaw: ApiCallLog[] = [];

  constructor(id: string) {
    this.id = id;
    this.dir = join(LOGS_DIR, id);
    this.startTime = performance.now();

    // Create log directory
    mkdirSync(this.dir, { recursive: true });

    this.logTerminal(`[Trace] Started solve trace: ${id}`);
  }

  private logTerminal(message: string): void {
    console.log(message);
  }

  private writeFile(filename: string, data: unknown): void {
    const filepath = join(this.dir, filename);
    const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    writeFileSync(filepath, content, "utf-8");
  }

  private appendFile(filename: string, data: string): void {
    const filepath = join(this.dir, filename);
    appendFileSync(filepath, data + "\n", "utf-8");
  }

  /**
   * Log the initial request
   */
  logRequest(prompt: string, filesCount: number, baseUrl: string): void {
    const step: TraceStep = {
      phase: "request",
      timestamp: new Date().toISOString(),
      input: { prompt, filesCount, baseUrl },
    };
    this.steps.push(step);
    this.writeFile("00-request.json", step);

    const promptPreview = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
    this.logTerminal(`[Trace] Request: "${promptPreview}" (${filesCount} files)`);
  }

  /**
   * Log classification result
   */
  logClassification(
    taskType: string,
    method: "llm" | "regex",
    confidence: number | undefined,
    durationMs: number,
    model?: string,
  ): void {
    const step: TraceStep = {
      phase: "classification",
      timestamp: new Date().toISOString(),
      durationMs,
      model,
      output: { taskType, method, confidence },
    };
    this.steps.push(step);
    this.writeFile("01-classification.json", step);

    const confStr = confidence ? ` (${(confidence * 100).toFixed(0)}%)` : "";
    this.logTerminal(`[Trace] Classified: ${taskType}${confStr} via ${method} in ${durationMs}ms`);
  }

  /**
   * Log entity extraction result
   */
  logEntityExtraction(
    taskType: string,
    entities: unknown[],
    durationMs: number,
    model?: string,
  ): void {
    const step: TraceStep = {
      phase: "entity_extraction",
      timestamp: new Date().toISOString(),
      durationMs,
      model,
      input: { taskType },
      output: { entities },
    };
    this.steps.push(step);
    this.writeFile("02-entity-extraction.json", step);

    this.logTerminal(`[Trace] Extracted ${entities.length} entity/entities for ${taskType} in ${durationMs}ms`);
  }

  /**
   * Log multi-task sequence (when prompt requires multiple tasks)
   */
  logTaskSequence(tasks: { taskType: string; entities: unknown[] }[], language: string): void {
    const step: TraceStep = {
      phase: "task_sequence",
      timestamp: new Date().toISOString(),
      output: { tasks, language },
    };
    this.steps.push(step);
    this.writeFile("03-task-sequence.json", step);

    const taskTypes = tasks.map(t => t.taskType).join(" → ");
    this.logTerminal(`[Trace] Sequence: ${taskTypes} (${language})`);
  }

  /**
   * Log handler execution start
   */
  logHandlerStart(taskType: string, handlerType: "dedicated" | "generic"): void {
    const step: TraceStep = {
      phase: "handler_start",
      timestamp: new Date().toISOString(),
      input: { taskType, handlerType },
    };
    this.steps.push(step);
    this.appendFile("06-execution.log", `[${step.timestamp}] START ${taskType} (${handlerType})`);

    this.logTerminal(`[Trace] Executing: ${taskType} via ${handlerType} handler`);
  }

  /**
   * Log an API call (summary to execution.log)
   */
  logApiCall(
    method: string,
    endpoint: string,
    status: number,
    durationMs: number,
    error?: string,
  ): void {
    const timestamp = new Date().toISOString();
    const statusIcon = status >= 200 && status < 300 ? "✓" : "✗";
    const line = `[${timestamp}] ${statusIcon} ${method} ${endpoint} → ${status} (${durationMs}ms)${error ? ` ERROR: ${error}` : ""}`;
    this.appendFile("06-execution.log", line);

    // Concise terminal output for API calls
    if (status >= 400) {
      this.logTerminal(`[Trace] API ${method} ${endpoint} → ${status} ERROR`);
    }
  }

  /**
   * Store raw API call logs (with full request/response bodies)
   */
  logRawApiCalls(calls: ApiCallLog[]): void {
    this.apiCallsRaw = calls;
    this.writeFile("04-api-calls-raw.json", calls);
  }

  /**
   * Log handler execution complete
   */
  logHandlerComplete(taskType: string, success: boolean, durationMs: number, error?: string): void {
    const step: TraceStep = {
      phase: "handler_complete",
      timestamp: new Date().toISOString(),
      durationMs,
      output: { taskType, success },
      error,
    };
    this.steps.push(step);
    this.appendFile("06-execution.log", `[${step.timestamp}] END ${taskType} success=${success} (${durationMs}ms)`);

    const status = success ? "completed" : "FAILED";
    this.logTerminal(`[Trace] Handler ${taskType} ${status} in ${durationMs}ms`);
  }

  /**
   * Log final result
   */
  logResult(
    success: boolean,
    apiCallStats: { total: number; errors: number },
    error?: string,
  ): void {
    const totalMs = Math.round(performance.now() - this.startTime);
    const step: TraceStep = {
      phase: "result",
      timestamp: new Date().toISOString(),
      durationMs: totalMs,
      output: { success, apiCallStats },
      error,
    };
    this.steps.push(step);

    // Write final summary
    this.writeFile("07-result.json", {
      id: this.id,
      success,
      totalDurationMs: totalMs,
      apiCalls: apiCallStats,
      error,
      steps: this.steps,
    });

    const status = success ? "SUCCESS" : "FAILED";
    this.logTerminal(
      `[Trace] ${status} in ${totalMs}ms | API: ${apiCallStats.total} calls, ${apiCallStats.errors} errors`,
    );
    this.logTerminal("");
    this.logTerminal("");
  }

  /**
   * Log arbitrary debug info
   */
  debug(label: string, data: unknown): void {
    const timestamp = new Date().toISOString();
    this.appendFile("debug.log", `[${timestamp}] ${label}: ${JSON.stringify(data)}`);
  }
}

/**
 * Create a new solve trace for a request
 */
export function createSolveTrace(solveId: string): SolveTrace {
  return new SolveTrace(solveId);
}
