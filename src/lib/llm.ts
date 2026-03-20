import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config.js";
import type { FileAttachment, ParsedTask, TaskType } from "../types/index.js";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.openrouter.apiKey,
  compatibility: "compatible",
});

const TASK_TYPES: TaskType[] = [
  "create_employee",
  "update_employee",
  "create_customer",
  "update_customer",
  "create_product",
  "create_department",
  "create_invoice",
  "send_invoice",
  "create_payment",
  "create_credit_note",
  "create_order",
  "create_travel_expense",
  "delete_travel_expense",
  "create_project",
  "create_voucher",
  "create_supplier",
  "unknown",
];

const ParsedTaskSchema = z.object({
  taskType: z.enum(TASK_TYPES as [string, ...string[]]),
  entities: z.array(z.record(z.unknown())),
  language: z.string(),
});

const SYSTEM_PROMPT = `You are an expert accounting task parser for the Norwegian accounting system Tripletex.
You receive a task prompt (potentially in Norwegian, Nynorsk, English, Spanish, Portuguese, German, or French) and must extract structured information.

Your job is to:
1. Identify the task type from the list of known types.
2. Extract all entities and their field values mentioned in the prompt.
3. Detect the language of the prompt.

Task types and their entity fields:

- create_employee: fields: firstName, lastName, email, phoneNumber, phoneNumberMobile, dateOfBirth, employeeNumber, userType
- update_employee: fields: firstName, lastName (to find) + any updated fields
- create_customer: fields: name, email, organizationNumber, phoneNumber, postalAddress
- update_customer: fields: name (to find) + any updated fields
- create_product: fields: name, unitPrice, number, description
- create_department: fields: name, departmentNumber
- create_order: ONE entity with: customerName, orderDate (YYYY-MM-DD), deliveryDate (YYYY-MM-DD), ourReference, yourReference. Plus extra entities for products: name, quantity, unitPrice.
- create_invoice: fields: customerName, orderId, invoiceDate (YYYY-MM-DD), dueDate (YYYY-MM-DD), comment
- send_invoice: same as create_invoice — creates and sends immediately
- create_payment: fields: invoiceId, amount, paymentDate (YYYY-MM-DD)
- create_credit_note: fields: invoiceId, comment
- create_travel_expense: fields: employeeFirstName, employeeLastName, date (YYYY-MM-DD), amount, description, paymentType (COMPANY_CARD or EMPLOYEE_PAID)
- delete_travel_expense: fields: employeeFirstName, employeeLastName OR travelExpenseId
- create_project: fields: name, projectManagerFirstName, projectManagerLastName, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), customerName, description
- create_voucher: fields: date (YYYY-MM-DD), description. Plus extra entities for postings: accountNumber, amount, type (DEBIT/CREDIT), description.
- create_supplier: fields: name, email, organizationNumber, phoneNumber
- unknown: If the task doesn't match any known type

Rules:
- All dates must be in YYYY-MM-DD format. Infer from context or use today if not given.
- For multiple entities (e.g. "create three departments"), return each as a separate entity in the array.
- For orders: first entity = order metadata, additional entities = product lines.
- For vouchers: first entity = voucher metadata, additional entities = posting lines.
- Extract ALL field values mentioned. Use English field names.`;

/** Optional shorter system prompt for A/B testing prompt variants. */
const SYSTEM_PROMPT_MINIMAL = `You parse Tripletex accounting prompts into JSON: task type, entities (English field names), and prompt language.
Known task types: create_employee, update_employee, create_customer, update_customer, create_product, create_department, create_invoice, send_invoice, create_payment, create_credit_note, create_order, create_travel_expense, delete_travel_expense, create_project, create_voucher, create_supplier, unknown.
Return one entity per distinct object (e.g. each department separately).`;

export const SYSTEM_PROMPT_VARIANTS = {
  default: SYSTEM_PROMPT,
  minimal: SYSTEM_PROMPT_MINIMAL,
} as const;

export type SystemPromptVariant = keyof typeof SYSTEM_PROMPT_VARIANTS;

export interface ParsePromptOptions {
  /** OpenRouter model id, e.g. anthropic/claude-sonnet-4.6 */
  model?: string;
  /** Named system prompt variant (default | minimal). Unknown keys fall back to default. */
  systemPromptVariant?: string;
}

function resolveSystemPrompt(variant?: string): string {
  if (!variant) return SYSTEM_PROMPT_VARIANTS.default;
  const key = variant as keyof typeof SYSTEM_PROMPT_VARIANTS;
  return SYSTEM_PROMPT_VARIANTS[key] ?? SYSTEM_PROMPT_VARIANTS.default;
}

export async function parsePrompt(
  prompt: string,
  files: FileAttachment[] = [],
  options?: ParsePromptOptions,
): Promise<ParsedTask> {
  const userContent = buildUserMessage(prompt, files);
  const modelId = options?.model ?? config.openrouter.model;
  const system = resolveSystemPrompt(options?.systemPromptVariant);

  const start = performance.now();
  const { object } = await generateObject({
    model: openrouter(modelId),
    schema: ParsedTaskSchema,
    system,
    prompt: userContent,
  });
  const durationMs = Math.round(performance.now() - start);

  console.log(
    `[LLM] Parsed task: ${object.taskType} (${object.language}) in ${durationMs}ms`,
  );

  return {
    taskType: object.taskType as TaskType,
    entities: object.entities,
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
