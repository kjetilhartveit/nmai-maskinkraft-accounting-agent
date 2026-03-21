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

export type TaskType =
  | "create_employee"
  | "update_employee"
  | "create_customer"
  | "update_customer"
  | "create_product"
  | "create_department"
  | "create_invoice"
  | "send_invoice"
  | "create_payment"
  | "create_credit_note"
  | "create_order"
  | "create_travel_expense"
  | "delete_travel_expense"
  | "create_project"
  | "create_voucher"
  | "create_supplier"
  | "create_payroll"
  | "create_supplier_invoice"
  | "create_dimension"
  | "unknown";

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
