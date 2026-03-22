import type { ApiCallLog, ParsedTaskSequence, TaskType } from "../types/index.js";

export interface TestCase {
  id: string;
  prompt: string;
  language: string;
  tier: 1 | 2 | 3;
  taskType: TaskType;
  taskTypeAlternatives?: TaskType[];
  expectedEntities: Record<string, unknown>[];
  expectedApiCalls: { max: number; maxErrors: number };
  /** Whether this test case requires an attached file to execute */
  requiresFile?: boolean;
  fileType?: "pdf" | "csv";
  expectedTaskSequence?: { taskType: TaskType; entities: Record<string, unknown>[] }[];
  notes?: string;
}

export interface EvalConfig {
  model: string;
  systemPromptVariant?: string;
  description?: string;
}

export interface EvalResult {
  testCaseId: string;
  config: EvalConfig;
  parsedSequence?: ParsedTaskSequence;
  apiCalls: { count: number; errors: number };
  apiCallDetails: ApiCallLog[];
  elapsedMs: number;
  success: boolean;
  serverReportedSuccess: boolean;
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
