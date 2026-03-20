import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config.js";
import type { FileAttachment, ParsedTask, ParsedTaskSequence, TaskType } from "../types/index.js";

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

const TaskSchema = z.object({
  taskType: z.enum(TASK_TYPES as [string, ...string[]]),
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
- For multiple entities of the same type (e.g. "create three departments"), return ONE task with each entity in the array.
- For orders: first entity = order metadata, additional entities = product lines.
- For vouchers: first entity = voucher metadata, additional entities = posting lines.
- Extract ALL field values mentioned. Use English field names.
- If the prompt involves a chain of operations (e.g. "create a customer and send them an invoice"), return multiple tasks in the correct execution order.
- IMPORTANT: Reuse references between tasks. If you create a customer "Acme Ltd" and then create an invoice for them, use the same customerName "Acme Ltd" in both tasks.`;

const SYSTEM_PROMPT_MINIMAL = `You parse Tripletex accounting prompts into JSON: tasks array (each with taskType and entities), and prompt language.
Known task types: create_employee, update_employee, create_customer, update_customer, create_product, create_department, create_invoice, send_invoice, create_payment, create_credit_note, create_order, create_travel_expense, delete_travel_expense, create_project, create_voucher, create_supplier, unknown.
Return one entity per distinct object (e.g. each department separately). For multi-step operations, return multiple tasks in dependency order.`;

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

const TASK_PRIORITY: Record<string, number> = {
  create_department: 0,
  create_employee: 1,
  create_customer: 1,
  create_supplier: 1,
  update_employee: 2,
  update_customer: 2,
  create_product: 2,
  create_order: 3,
  create_project: 3,
  create_voucher: 3,
  create_travel_expense: 3,
  create_invoice: 4,
  send_invoice: 4,
  delete_travel_expense: 4,
  create_payment: 5,
  create_credit_note: 5,
  unknown: 99,
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
  const modelId = options?.model ?? config.openrouter.model;
  const system = resolveSystemPrompt(options?.systemPromptVariant);

  const start = performance.now();
  const { object } = await generateObject({
    model: openrouter(modelId),
    schema: ParsedResponseSchema,
    system,
    prompt: userContent,
  });
  const durationMs = Math.round(performance.now() - start);

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
