import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "./config.js";
import type { FileAttachment, ParsedTask, TaskType } from "../types/index.js";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.openrouter.apiKey,
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

Task types:
- create_employee: Create a new employee (fields: firstName, lastName, email, phoneNumber, etc.)
- update_employee: Modify an existing employee
- create_customer: Register a new customer (fields: name, email, organizationNumber, isCustomer, etc.)
- update_customer: Modify an existing customer
- create_product: Add a product (fields: name, number, unitPrice, vatType, etc.)
- create_department: Create department(s) (fields: name, departmentNumber)
- create_invoice: Create an invoice (may need customer + product + order first)
- send_invoice: Create and send an invoice
- create_payment: Register a payment on an invoice
- create_credit_note: Issue a credit note
- create_order: Create an order
- create_travel_expense: Register a travel expense report
- delete_travel_expense: Delete a travel expense
- create_project: Create a project (fields: name, projectManager, customer, etc.)
- create_voucher: Create a ledger voucher
- create_supplier: Register a supplier (fields: name, organizationNumber, email, isSupplier, etc.)
- unknown: If the task doesn't match any known type

For entities, extract ALL field values mentioned in the prompt. Use English field names.
Common fields:
- Names: firstName, lastName, name
- Contact: email, phoneNumber, phoneNumberMobile
- Organization: organizationNumber
- Financial: amount, unitPrice, vatType, currency
- Dates: date, dueDate, invoiceDate
- Roles: isAdmin, isCustomer, isSupplier
- References: customerName, projectName, departmentName

When creating invoices, also extract the product/service description and customer details.
For multiple entities (e.g., "create three departments"), return each as a separate entity in the array.`;

export async function parsePrompt(
  prompt: string,
  files: FileAttachment[] = [],
): Promise<ParsedTask> {
  const userContent = buildUserMessage(prompt, files);

  const start = performance.now();
  const { object } = await generateObject({
    model: openrouter(config.openrouter.model),
    schema: ParsedTaskSchema,
    system: SYSTEM_PROMPT,
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
