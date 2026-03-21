import { z } from "zod";
import { config } from "./config.js";
import { geminiGenerateStructured } from "./gemini.js";
import type { FileAttachment, ParsedTask, ParsedTaskSequence, TaskType } from "../types/index.js";
import { ALL_TASK_TYPES } from "../types/index.js";

const TaskSchema = z.object({
  taskType: z.enum(ALL_TASK_TYPES as [string, ...string[]]),
  entities: z.array(z.record(z.unknown())),
});

const ParsedResponseSchema = z.object({
  tasks: z.array(TaskSchema).min(1),
  language: z.string(),
});

const SYSTEM_PROMPT = `You are an expert accounting task parser for the Norwegian accounting system Tripletex.
You receive a task prompt (potentially in Norwegian, Nynorsk, English, Spanish, Portuguese, German, or French) and must extract structured information.

Your job is to:
1. Identify ALL task types needed to fulfil the prompt. A single prompt may require multiple sequential operations.
2. Extract all entities and their field values for each task.
3. Detect the language of the prompt.
4. Order tasks so dependencies come first (e.g. create a customer before creating an invoice for that customer).

Task types: ${ALL_TASK_TYPES.join(", ")}

Rules:
- PRESERVE all Unicode characters exactly as they appear in the prompt (e.g. å, ø, æ, ü, ö, ñ, é, ã). Do NOT transliterate or anglicize names.
- All dates must be in YYYY-MM-DD format. Infer from context or use today if not given.
- For multiple entities of the same type (e.g. "create three departments"), return ONE task with each entity in the array.
- Extract ALL field values mentioned. Use English field names.
- If the prompt involves a chain of operations, return multiple tasks in the correct execution order.
- IMPORTANT: Reuse references between tasks. If you create a customer "Acme Ltd" and then create an invoice for them, use the same customerName "Acme Ltd" in both tasks.`;

const SYSTEM_PROMPT_MINIMAL = `You parse Tripletex accounting prompts into JSON: tasks array (each with taskType and entities), and prompt language.
Known task types: ${ALL_TASK_TYPES.join(", ")}.
Return one entity per distinct object (e.g. each department separately). For multi-step operations, return multiple tasks in dependency order.`;

export const SYSTEM_PROMPT_VARIANTS = {
  default: SYSTEM_PROMPT,
  minimal: SYSTEM_PROMPT_MINIMAL,
} as const;

export type SystemPromptVariant = keyof typeof SYSTEM_PROMPT_VARIANTS;

export interface ParsePromptOptions {
  model?: string;
  systemPromptVariant?: string;
}

function resolveSystemPrompt(variant?: string): string {
  if (!variant) return SYSTEM_PROMPT_VARIANTS.default;
  const key = variant as keyof typeof SYSTEM_PROMPT_VARIANTS;
  return SYSTEM_PROMPT_VARIANTS[key] ?? SYSTEM_PROMPT_VARIANTS.default;
}

const TASK_PRIORITY: Record<string, number> = {
  create_department: 0,
  create_employee: 1,
  employee_onboarding_pdf: 1,
  employee_contract_pdf: 1,
  create_customer: 1,
  create_supplier: 1,
  create_product: 2,
  create_order: 3,
  create_project: 3,
  create_travel_expense: 3,
  create_payroll: 3,
  create_supplier_invoice: 3,
  supplier_invoice_pdf: 3,
  create_dimension: 3,
  fx_payment: 3,
  bank_reconciliation: 3,
  ledger_audit: 3,
  ledger_analysis: 3,
  year_end_closing: 3,
  monthly_closing: 3,
  project_lifecycle: 3,
  receipt_expense: 3,
  reminder_fee: 3,
  create_invoice: 4,
  send_invoice: 4,
  create_payment: 5,
  create_credit_note: 5,
};

function sortByDependency(tasks: ParsedTask[]): ParsedTask[] {
  return [...tasks].sort((a, b) => {
    const pa = TASK_PRIORITY[a.taskType] ?? 50;
    const pb = TASK_PRIORITY[b.taskType] ?? 50;
    return pa - pb;
  });
}

export async function parsePrompt(
  prompt: string,
  files: FileAttachment[] = [],
  options?: ParsePromptOptions,
): Promise<ParsedTaskSequence> {
  const userContent = buildUserMessage(prompt, files);
  const modelId = options?.model ?? config.google.model;
  const system = resolveSystemPrompt(options?.systemPromptVariant);

  const formatInstruction = `\n\nRespond with valid JSON matching this exact structure:
{"tasks": [{"taskType": "<type>", "entities": [{...}]}], "language": "<lang_code>"}`;

  const { object, durationMs } = await geminiGenerateStructured({
    model: modelId,
    system: system + formatInstruction,
    prompt: userContent,
    schema: ParsedResponseSchema,
    maxTokens: 4096,
  });

  const tasks: ParsedTask[] = object.tasks.map((t) => ({
    taskType: t.taskType as TaskType,
    entities: t.entities,
    language: object.language,
    rawPrompt: prompt,
  }));

  const sorted = sortByDependency(tasks);

  const taskTypes = sorted.map((t) => t.taskType).join(" → ");
  console.log(
    `[LLM] Parsed ${sorted.length} task(s): ${taskTypes} (${object.language}) in ${durationMs}ms`,
  );

  return {
    tasks: sorted,
    language: object.language,
    rawPrompt: prompt,
  };
}

function buildUserMessage(prompt: string, files: FileAttachment[]): string {
  let message = `Parse the following accounting task prompt:\n\n${prompt}`;

  if (files.length > 0) {
    message += `\n\nAttached files:\n`;
    for (const file of files) {
      message += `- ${file.filename} (${file.mime_type})\n`;
    }
    message +=
      "\nNote: File contents are attached but not shown here. Extract any relevant information from the prompt itself.";
  }

  return message;
}
