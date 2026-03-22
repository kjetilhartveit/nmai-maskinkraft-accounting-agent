import { z } from "zod";

export const FileAttachmentSchema = z.object({
  filename: z.string(),
  content_base64: z.string(),
  mime_type: z.string(),
});

export const TripletexCredentialsSchema = z.object({
  base_url: z.string().url(),
  session_token: z.string().min(1),
});

export const SolveRequestSchema = z.object({
  prompt: z.string().min(1),
  files: z.array(FileAttachmentSchema).nullable().default([]).transform(v => v ?? []),
  tripletex_credentials: TripletexCredentialsSchema,
});

export type FileAttachment = z.infer<typeof FileAttachmentSchema>;
export type TripletexCredentials = z.infer<typeof TripletexCredentialsSchema>;
export type SolveRequest = z.infer<typeof SolveRequestSchema>;

export interface SolveResponse {
  status: "completed";
}

/**
 * Exactly 31 task types — one per competition prompt template.
 * No "unknown" fallback; every prompt maps to exactly one type.
 */
export type TaskType =
  // Tier 1 — Simple CRUD
  | "create_customer"
  | "create_employee"
  | "create_department"
  | "create_supplier"
  | "create_product"
  | "activate_module"
  // Tier 2 — Multi-step
  | "create_project"
  | "create_invoice"
  | "send_invoice"
  | "create_order"
  | "create_payment"
  | "create_credit_note"
  | "create_travel_expense"
  | "create_payroll"
  | "create_supplier_invoice"
  | "create_dimension"
  | "reverse_payment"
  | "project_fixed_price"
  | "create_timesheet"
  // Tier 3 — Complex / file-based
  | "receipt_expense"
  | "employee_onboarding_pdf"
  | "employee_contract_pdf"
  | "supplier_invoice_pdf"
  | "bank_reconciliation"
  | "ledger_audit"
  | "ledger_analysis"
  | "year_end_closing"
  | "monthly_closing"
  | "fx_payment"
  | "project_lifecycle"
  | "reminder_fee";

export const ALL_TASK_TYPES: TaskType[] = [
  "create_customer", "create_employee", "create_department", "create_supplier", "create_product",
  "activate_module",
  "create_project", "create_invoice", "send_invoice", "create_order", "create_payment",
  "create_credit_note", "create_travel_expense", "create_payroll", "create_supplier_invoice",
  "create_dimension", "reverse_payment", "project_fixed_price", "create_timesheet",
  "receipt_expense", "employee_onboarding_pdf", "employee_contract_pdf", "supplier_invoice_pdf",
  "bank_reconciliation", "ledger_audit", "ledger_analysis", "year_end_closing", "monthly_closing",
  "fx_payment", "project_lifecycle", "reminder_fee",
];

export interface ParsedTask {
  taskType: TaskType;
  entities: Record<string, unknown>[];
  language: string;
  rawPrompt: string;
}

export interface ParsedTaskSequence {
  tasks: ParsedTask[];
  language: string;
  rawPrompt: string;
}

export interface TripletexListResponse<T> {
  fullResultSize: number;
  from: number;
  count: number;
  versionDigest: string;
  values: T[];
}

export interface TripletexSingleResponse<T> {
  value: T;
}

export interface ApiCallLog {
  method: string;
  endpoint: string;
  status: number;
  durationMs: number;
  isError: boolean;
  errorBody?: string;
}
