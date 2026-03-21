import db from "../lib/db.js";
import type { TestCase } from "./types.js";
import type { TaskType } from "../types/index.js";

interface SolveRow {
  parsed_sequence: string | null;
  success: number;
  api_call_total: number;
  api_call_errors: number;
  elapsed_ms: number;
  error: string | null;
  timestamp: string;
  source: string;
}

export interface TaskTypeStats {
  taskType: string;
  total: number;
  passed: number;
  failed: number;
  successRate: number;
  avgCalls: number;
  avgErrors: number;
  avgMs: number;
  lastError?: string;
}

/**
 * Query the solve database for the N task types with the most failures.
 * Uses the parsed_sequence JSON stored in each solve row.
 */
export function getTopFailingTaskTypes(limit = 10): TaskTypeStats[] {
  const rows = db
    .prepare("SELECT parsed_sequence, success, api_call_total, api_call_errors, elapsed_ms, error, timestamp, source FROM solves ORDER BY timestamp DESC")
    .all() as SolveRow[];

  const groups = new Map<string, { passed: number; failed: number; totalCalls: number; totalErrors: number; totalMs: number; count: number; lastError?: string }>();

  for (const row of rows) {
    let key = "unknown";
    if (row.parsed_sequence) {
      try {
        const seq = JSON.parse(row.parsed_sequence) as { tasks?: { taskType: string }[] };
        if (seq.tasks?.length) {
          key = seq.tasks.map((t) => t.taskType).join(" > ");
        }
      } catch { /* ignore malformed */ }
    }

    const g = groups.get(key) ?? { passed: 0, failed: 0, totalCalls: 0, totalErrors: 0, totalMs: 0, count: 0 };
    g.count++;
    if (row.success) g.passed++;
    else {
      g.failed++;
      if (!g.lastError && row.error) g.lastError = row.error;
    }
    g.totalCalls += row.api_call_total;
    g.totalErrors += row.api_call_errors;
    g.totalMs += row.elapsed_ms ?? 0;
    groups.set(key, g);
  }

  return [...groups.entries()]
    .map(([taskType, g]) => ({
      taskType,
      total: g.count,
      passed: g.passed,
      failed: g.failed,
      successRate: g.count > 0 ? Math.round((g.passed / g.count) * 100) : 0,
      avgCalls: Math.round((g.totalCalls / g.count) * 10) / 10,
      avgErrors: Math.round((g.totalErrors / g.count) * 10) / 10,
      avgMs: Math.round(g.totalMs / g.count),
      lastError: g.lastError,
    }))
    .sort((a, b) => {
      if (a.failed !== b.failed) return b.failed - a.failed;
      return a.successRate - b.successRate;
    })
    .slice(0, limit);
}

export interface TaskTypeVariation {
  id: string;
  language: string;
  tier: 1 | 2 | 3;
  prompt: string;
  notes?: string;
  taskTypeAlternatives?: TaskType[];
  expectedTaskSequence?: { taskType: TaskType }[];
}

/**
 * For a given task type, return all test case variations grouped by language.
 * Also matches multi-task sequences where the task type appears anywhere in the pipeline.
 */
export function getVariationsForTaskType(
  taskType: string,
  allCases: TestCase[],
): { byLanguage: Record<string, TaskTypeVariation[]>; total: number } {
  const matching = allCases.filter((tc) => {
    if (tc.taskType === taskType) return true;
    if (tc.taskTypeAlternatives?.includes(taskType as TaskType)) return true;
    if (tc.expectedTaskSequence?.some((s) => s.taskType === taskType)) return true;
    return false;
  });

  const byLanguage: Record<string, TaskTypeVariation[]> = {};
  for (const tc of matching) {
    const lang = tc.language;
    if (!byLanguage[lang]) byLanguage[lang] = [];
    byLanguage[lang].push({
      id: tc.id,
      language: tc.language,
      tier: tc.tier,
      prompt: tc.prompt,
      notes: tc.notes,
      taskTypeAlternatives: tc.taskTypeAlternatives,
      expectedTaskSequence: tc.expectedTaskSequence?.map((s) => ({ taskType: s.taskType })),
    });
  }

  return { byLanguage, total: matching.length };
}

/**
 * Select one representative test case per task type for fast feedback loops.
 * Prefers tier 2 > tier 3 > tier 1 to focus on medium/complex tasks.
 * Within a tier, picks the first available.
 */
export function pickOnePerTaskType(cases: TestCase[]): TestCase[] {
  const byType = new Map<string, TestCase[]>();
  for (const tc of cases) {
    const key = tc.taskType;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(tc);
  }

  const picked: TestCase[] = [];
  for (const [, group] of byType) {
    const sorted = [...group].sort((a, b) => {
      const tierPriority = (t: number) => (t === 2 ? 0 : t === 3 ? 1 : 2);
      return tierPriority(a.tier) - tierPriority(b.tier);
    });
    picked.push(sorted[0]);
  }

  return picked;
}

/**
 * Get all distinct task types present in the test case set.
 */
export function getDistinctTaskTypes(cases: TestCase[]): string[] {
  return [...new Set(cases.map((tc) => tc.taskType))].sort();
}
