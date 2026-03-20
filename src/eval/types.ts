import type { ParsedTaskSequence, TaskType } from "../types/index.js";

export interface TestCase {
  id: string;
  prompt: string;
  language: string;
  /** Scoring tier (1–3); higher tiers apply larger multipliers in competition scoring. */
  tier: 1 | 2 | 3;
  /** Primary task type (for single-task prompts) or the first task type in a sequence. */
  taskType: TaskType;
  /** Other task types that still count as correct parse (e.g. create_invoice vs send_invoice). */
  taskTypeAlternatives?: TaskType[];
  /** Subset of fields each parsed entity should contain (order may differ). */
  expectedEntities: Record<string, unknown>[];
  /** Optional bounds for Tripletex HTTP efficiency checks. */
  expectedApiCalls?: { min?: number; max?: number; maxErrors?: number };
  /** For multi-task prompts: expected full task sequence. When present, overrides taskType matching. */
  expectedTaskSequence?: { taskType: TaskType; entities: Record<string, unknown>[] }[];
  notes?: string;
}

export interface EvalConfig {
  /** OpenRouter model id */
  model: string;
  systemPromptVariant?: string;
  /** Human-readable label for reports */
  description?: string;
}

export interface EvalResult {
  testCaseId: string;
  config: EvalConfig;
  parsedSequence?: ParsedTaskSequence;
  apiCalls: { count: number; errors: number };
  elapsedMs: number;
  /** True when expectations match and optional API bounds satisfied (and server completed without thrown error). */
  success: boolean;
  /** Whether the HTTP eval payload reported execution success */
  serverReportedSuccess: boolean;
  /** Task type / language / entity checks */
  parseMatch: boolean;
  error?: string;
}

export interface EvalSummary {
  config: EvalConfig;
  totalCases: number;
  passed: number;
  failed: number;
  avgElapsedMs: number;
  totalApiCalls: number;
  totalApiErrors: number;
}
