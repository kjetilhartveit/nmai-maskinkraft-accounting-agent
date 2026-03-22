import type { ApiCallLog, ParsedTaskSequence, TaskType } from "../types/index.js";

export type EntityType =
  | "customer" | "employee" | "department" | "supplier" | "product"
  | "project" | "voucher" | "invoice" | "activity" | "travelExpense"
  | "payment" | "creditNote" | "order" | "timesheetEntry" | "dimension";

export interface ExpectedEntity {
  _type: EntityType;
  _minCount?: number;
  [key: string]: unknown;
}

export interface TestCase {
  id: string;
  prompt: string;
  language: string;
  tier: 1 | 2 | 3;
  taskType: TaskType;
  taskTypeAlternatives?: TaskType[];
  expectedEntities: ExpectedEntity[];
  expectedApiCalls: { max: number; maxErrors: number };
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
  apiCalls: { count: number; errors: number; writeCalls: number; writeErrors: number };
  apiCallDetails: ApiCallLog[];
  elapsedMs: number;
  success: boolean;
  serverReportedSuccess: boolean;
  parseMatch: boolean;
  sandboxVerified: boolean;
  sandboxFailures: string[];
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
