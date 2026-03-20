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
  - userType: "ADMINISTRATOR" if the prompt says admin/administrator/administrador/administrateur/administratör/Verwalter/tilgangsrettighet: administrator. "STANDARD" for regular users with email. "NO_ACCESS" if no email/login needed.
  - IMPORTANT: If the prompt asks to give someone admin rights, set userType to "ADMINISTRATOR".
- update_employee: fields: firstName, lastName (to find) + any updated fields
- create_customer: fields: name, email, organizationNumber, phoneNumber, postalAddress
- update_customer: fields: name (to find) + any updated fields
- create_product: fields: name, unitPrice, number, description, vatRate (percentage: 25, 15, 0, etc. — optional, defaults to 25%)
- create_department: fields: name, departmentNumber
- create_order: ONE entity with: customerName, orderDate (YYYY-MM-DD), deliveryDate (YYYY-MM-DD), ourReference, yourReference. Plus extra entities for products: name, quantity, unitPrice.
- create_invoice: First entity is invoice metadata: customerName, invoiceDate (YYYY-MM-DD), dueDate (YYYY-MM-DD), comment.
  For a SINGLE product line: include productName, amount (excluding VAT) directly in the first entity.
  For MULTIPLE product lines (different items, different VAT rates): add additional entities after the first, each with: productName, unitPrice (excluding VAT), quantity (default 1), vatRate (percentage: 25, 15, 12, 0, etc.)
  Example with 3 lines: [{ customerName: "Acme" }, { productName: "Widget A", unitPrice: 1000, quantity: 2, vatRate: 25 }, { productName: "Widget B", unitPrice: 500, quantity: 1, vatRate: 15 }, { productName: "Widget C", unitPrice: 300, quantity: 1, vatRate: 0 }]
- send_invoice: same as create_invoice — creates and sends immediately. Always extract the amount and product/service description. Supports multiple product lines.
- create_payment: fields: customerName, organizationNumber, amount, paymentDate (YYYY-MM-DD), description/service (what the invoice is for)
  - IMPORTANT: If the prompt says the client "has" a pending/outstanding invoice, the invoice ALREADY EXISTS in the sandbox. Return ONLY create_payment, NOT create_invoice + create_payment. The handler will find the existing invoice.
  - Keywords indicating existing invoice: "has a pending invoice", "tem uma fatura pendente", "tiene una factura pendiente", "hat eine ausstehende Rechnung", "har en utestående faktura", "a une facture en attente"
  - When the task is ONLY about registering/recording a payment on an existing invoice, use ONLY create_payment.
- create_credit_note: fields: invoiceId, comment
- create_travel_expense: fields: employeeFirstName, employeeLastName, date (YYYY-MM-DD), amount, description, paymentType (COMPANY_CARD or EMPLOYEE_PAID)
- delete_travel_expense: fields: employeeFirstName, employeeLastName OR travelExpenseId
- create_project: fields: name, projectManagerFirstName, projectManagerLastName, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), customerName, description
- create_voucher: fields: date (YYYY-MM-DD), description. Plus extra entities for postings: accountNumber, amount, type (DEBIT/CREDIT), description.
  - IMPORTANT: If the voucher must be LINKED to a custom dimension, accounting dimension, or other non-standard entity, use "unknown" for the ENTIRE task (dimension creation + voucher) so the agentic handler can maintain context.
- create_supplier: fields: name, email, organizationNumber, phoneNumber
- unknown: For ANY task that doesn't clearly match one of the above types, OR when a task involves custom accounting dimensions. This includes but is not limited to:
  custom accounting dimensions (even when combined with vouchers — the ENTIRE prompt should be ONE "unknown" task),
  bank reconciliation, incoming invoices, supplier invoices, salary operations, asset management,
  timesheet entries, company settings, contacts, divisions, correcting/reversing entries,
  activating modules, or any other Tripletex operation.
  - When a prompt asks to create a custom dimension AND then do something with it (like create a voucher linked to it), return a SINGLE "unknown" task containing ALL information. Do NOT split into unknown + create_voucher.

Rules:
- All dates must be in YYYY-MM-DD format. Infer from context or use today if not given.
- For multiple entities of the same type (e.g. "create three departments"), return ONE task with each entity in the array.
- For orders: first entity = order metadata, additional entities = product lines.
- For vouchers: first entity = voucher metadata, additional entities = posting lines.
- Extract ALL field values mentioned. Use English field names.
- If the prompt involves a chain of operations (e.g. "create a customer and send them an invoice"), return multiple tasks in the correct execution order.
- IMPORTANT: Reuse references between tasks. If you create a customer "Acme Ltd" and then create an invoice for them, use the same customerName "Acme Ltd" in both tasks.
- CRITICAL: Do NOT force tasks into a wrong type. If the prompt asks to create a "custom accounting dimension" or "regnskapsdimensjon", do NOT map it to create_department. Use "unknown" instead. The "unknown" handler is a full agentic system that can execute ANY Tripletex API operation.
- For "unknown" tasks: extract ALL information from the prompt into the entities array — names, values, numbers, dates, amounts, descriptions, account numbers, dimension names, etc. Put everything you can extract in the entity fields using descriptive field names.

Examples of correct parsing:

Example 1 - Payment on existing invoice (DO NOT create a new invoice):
Prompt: "O cliente Estrela Lda tem uma fatura pendente de 13650 NOK. Registe o pagamento."
→ tasks: [{ taskType: "create_payment", entities: [{ customerName: "Estrela Lda", amount: 13650 }] }]
WRONG: [{ taskType: "create_invoice" }, { taskType: "create_payment" }] — the invoice already exists!

Example 2 - Customer + invoice (MUST create customer first for fresh sandbox):
Prompt: "Crie e envie uma fatura ao cliente Porto Alegre Lda (org. nº 842889154) por 11200 NOK."
→ tasks: [{ taskType: "create_customer", entities: [{ name: "Porto Alegre Lda", organizationNumber: "842889154" }] }, { taskType: "send_invoice", entities: [{ customerName: "Porto Alegre Lda", amount: 11200 }] }]

Example 3 - Custom dimension + voucher (SINGLE unknown task):
Prompt: "Cree una dimensión contable personalizada Region con valores Nord-Norge y Vestlandet. Registre un asiento en cuenta 7100 por 34350 NOK vinculado a Nord-Norge."
→ tasks: [{ taskType: "unknown", entities: [{ dimensionName: "Region", dimensionValues: ["Nord-Norge", "Vestlandet"], accountNumber: 7100, amount: 34350, linkedDimensionValue: "Nord-Norge" }] }]

Example 4 - Employee with admin role:
Prompt: "Create employee Maria Svensson (maria@test.com) as an administrator."
→ tasks: [{ taskType: "create_employee", entities: [{ firstName: "Maria", lastName: "Svensson", email: "maria@test.com", userType: "ADMINISTRATOR" }] }]`;

const SYSTEM_PROMPT_MINIMAL = `You parse Tripletex accounting prompts into JSON: tasks array (each with taskType and entities), and prompt language.
Known task types: create_employee, update_employee, create_customer, update_customer, create_product, create_department, create_invoice, send_invoice, create_payment, create_credit_note, create_order, create_travel_expense, delete_travel_expense, create_project, create_voucher, create_supplier, unknown.
Return one entity per distinct object (e.g. each department separately). For multi-step operations, return multiple tasks in dependency order.
Use "unknown" for any operation not in the list above (accounting dimensions, bank reconciliation, salary, assets, etc.). Do NOT force into a wrong type. For unknown, extract all data into entities.`;

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
  unknown: 1, // unknown tasks often create prerequisites (dimensions, contacts, etc.)
  create_employee: 2,
  create_customer: 2,
  create_supplier: 2,
  update_employee: 3,
  update_customer: 3,
  create_product: 3,
  create_order: 4,
  create_project: 4,
  create_voucher: 4,
  create_travel_expense: 4,
  create_invoice: 5,
  send_invoice: 5,
  delete_travel_expense: 5,
  create_payment: 6,
  create_credit_note: 6,
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
    maxTokens: 4096,
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
