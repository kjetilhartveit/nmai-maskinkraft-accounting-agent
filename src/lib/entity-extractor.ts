/**
 * Entity Extractor — Task-type specific entity extraction.
 *
 * After the task classifier determines the task type, this module
 * extracts the relevant entities using focused, type-specific prompts.
 */

import { z } from "zod";
import { geminiGenerateStructured, type GeminiJsonSchema } from "./gemini.js";
import type { ParsedTask, TaskType, FileAttachment } from "../types/index.js";
import { config } from "./config.js";

// ── Entity schemas per task type ─────────────────────────────────────

const EmployeeEntitySchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().optional(),
  phoneNumber: z.string().optional(),
  phoneNumberMobile: z.string().optional(),
  dateOfBirth: z.string().optional(),
  employeeNumber: z.string().optional(),
  userType: z.enum(["ADMINISTRATOR", "EXTENDED", "NO_ACCESS"]).optional(),
  startDate: z.string().optional(),
  departmentName: z.string().optional(),
});

const CustomerEntitySchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  organizationNumber: z.string().optional(),
  phoneNumber: z.string().optional(),
  postalAddress: z.object({
    addressLine1: z.string().optional(),
    postalCode: z.string().optional(),
    city: z.string().optional(),
  }).optional(),
});

const DepartmentEntitySchema = z.object({
  name: z.string(),
  departmentNumber: z.string().optional(),
});

const SupplierEntitySchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  organizationNumber: z.string().optional(),
  phoneNumber: z.string().optional(),
});

const ProductEntitySchema = z.object({
  name: z.string(),
  unitPrice: z.number().optional(),
  number: z.string().optional(),
  description: z.string().optional(),
  vatRate: z.number().optional(),
});

const InvoiceEntitySchema = z.object({
  customerName: z.string(),
  organizationNumber: z.string().optional(),
  invoiceDate: z.string().optional(),
  dueDate: z.string().optional(),
  comment: z.string().optional(),
  productName: z.string().optional(),
  amount: z.number().optional(),
  lines: z.array(z.object({
    productName: z.string(),
    unitPrice: z.number(),
    quantity: z.number().optional(),
    vatRate: z.number().optional(),
  })).optional(),
});

const PaymentEntitySchema = z.object({
  customerName: z.string(),
  organizationNumber: z.string().optional(),
  amount: z.number().optional(),
  paymentDate: z.string().optional(),
  description: z.string().optional(),
});

const ProjectEntitySchema = z.object({
  name: z.string(),
  projectManagerFirstName: z.string().optional(),
  projectManagerLastName: z.string().optional(),
  projectManagerEmail: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  customerName: z.string().optional(),
  organizationNumber: z.string().optional(),
  description: z.string().optional(),
});

const PayrollEntitySchema = z.object({
  employeeFirstName: z.string(),
  employeeLastName: z.string(),
  employeeEmail: z.string().optional(),
  baseSalary: z.number(),
  bonus: z.number().optional(),
});

const SupplierInvoiceEntitySchema = z.object({
  supplierName: z.string(),
  organizationNumber: z.string().optional(),
  amount: z.number(),
  amountIncludesVat: z.boolean().optional(),
  accountNumber: z.number().optional(),
  vatRate: z.number().optional(),
  invoiceNumber: z.string().optional(),
  description: z.string().optional(),
});

const DimensionEntitySchema = z.object({
  dimensionName: z.string(),
  dimensionValues: z.array(z.string()),
  accountNumber: z.number().optional(),
  amount: z.number().optional(),
  linkedDimensionValue: z.string().optional(),
});

const TravelExpenseEntitySchema = z.object({
  employeeFirstName: z.string(),
  employeeLastName: z.string(),
  date: z.string().optional(),
  description: z.string().optional(),
  costs: z.array(z.object({
    amount: z.number(),
    description: z.string(),
  })).optional(),
});

const CreditNoteEntitySchema = z.object({
  customerName: z.string(),
  organizationNumber: z.string().optional(),
  amount: z.number(),
  productName: z.string().optional(),
  date: z.string().optional(),
  comment: z.string().optional(),
});

const GenericEntitySchema = z.record(z.unknown());

// Wrapper schema for extraction response
const ExtractionResponseSchema = z.object({
  entities: z.array(z.record(z.unknown())),
  language: z.string(),
  requiresPrerequisites: z.array(z.object({
    taskType: z.string(),
    reason: z.string(),
  })).optional(),
});

// ── Task-specific prompts ────────────────────────────────────────────

const TASK_PROMPTS: Record<string, string> = {
  create_employee: `Extract employee information:
- firstName, lastName (required)
- email, phoneNumber, phoneNumberMobile (optional)
- dateOfBirth (YYYY-MM-DD format)
- employeeNumber (optional)
- userType: "ADMINISTRATOR" if admin/administrator mentioned, "EXTENDED" if email given, "NO_ACCESS" otherwise
- startDate (YYYY-MM-DD, when they start working)
- departmentName (if mentioned)

For multiple employees, return multiple entities.`,

  create_customer: `Extract customer information:
- name (required, company name)
- email (optional)
- organizationNumber (org number, if provided)
- phoneNumber (optional)
- postalAddress: { addressLine1, postalCode, city } (if address given)

IMPORTANT: Preserve Unicode characters (å, ø, æ, ü, etc.) exactly.`,

  create_department: `Extract department information:
- name (required)
- departmentNumber (optional)

For multiple departments, return each as a separate entity.`,

  create_supplier: `Extract supplier information:
- name (required)
- email (optional)
- organizationNumber (if provided)
- phoneNumber (optional)`,

  create_product: `Extract product information:
- name (required)
- unitPrice (price excluding VAT)
- number (product number/code)
- description (optional)
- vatRate (percentage: 25, 15, 12, 0 — default 25 if not specified)`,

  create_invoice: `Extract invoice information:
- customerName (required)
- organizationNumber (if provided)
- invoiceDate, dueDate (YYYY-MM-DD)
- For single line: amount, productName
- For multiple lines: lines array with { productName, unitPrice, quantity, vatRate }

If org number provided, add requiresPrerequisites: [{ taskType: "create_customer", reason: "Customer must exist" }]`,

  send_invoice: `Same as create_invoice, but this invoice will be sent immediately.
Extract: customerName, organizationNumber, amount/lines, invoiceDate, dueDate.

If org number provided, add requiresPrerequisites: [{ taskType: "create_customer", reason: "Customer must exist" }]`,

  create_payment: `Extract payment information:
- customerName (required)
- organizationNumber (if provided)
- amount (payment amount)
- paymentDate (YYYY-MM-DD)
- description (what the invoice was for)

IMPORTANT: If prompt says customer "has" a pending/outstanding invoice, do NOT add create_invoice prerequisite.`,

  create_project: `Extract project information:
- name (project name, required)
- projectManagerFirstName, projectManagerLastName (if PM mentioned)
- projectManagerEmail (optional)
- startDate, endDate (YYYY-MM-DD)
- customerName (if linked to customer)
- organizationNumber (if provided)
- description (optional)`,

  create_payroll: `Extract payroll information:
- employeeFirstName, employeeLastName (required)
- employeeEmail (optional)
- baseSalary (base salary amount)
- bonus (bonus amount, if mentioned)

The handler finds/creates the employee automatically.`,

  create_supplier_invoice: `Extract incoming supplier invoice:
- supplierName (required)
- organizationNumber (if provided)
- amount (invoice amount)
- amountIncludesVat (true if "including VAT"/"inkl. mva" mentioned)
- accountNumber (expense account)
- vatRate (percentage, usually 25)
- invoiceNumber (if provided)
- description (what the invoice is for)

Add requiresPrerequisites: [{ taskType: "create_supplier", reason: "Supplier must exist" }]`,

  create_dimension: `Extract custom accounting dimension:
- dimensionName (name of the dimension)
- dimensionValues (array of value names)
- accountNumber (if voucher posting needed)
- amount (if voucher posting needed)
- linkedDimensionValue (which value to link the voucher to)`,

  create_travel_expense: `Extract travel expense:
- employeeFirstName, employeeLastName (required)
- date (YYYY-MM-DD)
- description (trip title)
- costs: array of { amount, description } for each expense item

IMPORTANT: For per-diem/diett, compute total (days × daily rate) as amount.`,

  create_credit_note: `Extract credit note information:
- customerName (required)
- organizationNumber (if provided)
- amount (credit amount)
- productName (what the original invoice was for)
- date (YYYY-MM-DD)
- comment (reason for credit)

Add requiresPrerequisites: [{ taskType: "create_customer", reason: "Customer must exist" }]`,

  reverse_payment: `Extract payment reversal:
- customerName (required)
- organizationNumber (if provided)
- amount (payment amount being reversed)
- description (what the original invoice was for)`,

  project_fixed_price: `Extract fixed-price project:
- projectName (required)
- customerName (required)
- organizationNumber (if provided)
- projectManagerFirstName, projectManagerLastName
- projectManagerEmail (optional)
- fixedPrice (the fixed price amount)
- invoicePercentage (percentage to invoice, e.g. 75)`,

  create_timesheet: `Extract timesheet entry:
- employeeFirstName, employeeLastName
- employeeEmail (optional)
- hours (number of hours)
- activityName (activity/task name)
- projectName (project name)
- customerName (if mentioned)
- organizationNumber (if mentioned)
- hourlyRate (if mentioned)
- date (YYYY-MM-DD)`,

  create_order: `Extract order information:
First entity is order metadata:
- customerName (required)
- organizationNumber (if provided)
- orderDate, deliveryDate (YYYY-MM-DD)
- ourReference, yourReference (optional)

Additional entities for product lines:
- name (product name)
- quantity (default 1)
- unitPrice (price per unit)
- productNumber (if given in parentheses)`,

  unknown: `Extract ALL information from the prompt:
- Names, values, numbers, dates, amounts
- Descriptions, account numbers, references
- Any entity relationships mentioned

Put everything into structured entities with descriptive field names.`,
};

// ── Main extraction function ─────────────────────────────────────────

export interface ExtractionResult {
  entities: Record<string, unknown>[];
  language: string;
  prerequisites: { taskType: TaskType; entities: Record<string, unknown>[] }[];
  durationMs: number;
}

export async function extractEntities(
  taskType: TaskType,
  prompt: string,
  files: FileAttachment[] = [],
  options?: { model?: string },
): Promise<ExtractionResult> {
  const start = performance.now();
  const modelId = options?.model ?? config.google.model;

  const taskPrompt = TASK_PROMPTS[taskType] ?? TASK_PROMPTS.unknown;

  const systemPrompt = `You extract structured entities from accounting task prompts.
The task type is: ${taskType}

${taskPrompt}

Rules:
- All dates in YYYY-MM-DD format
- Preserve Unicode characters exactly (å, ø, æ, ü, ö, ñ, é, ã)
- Use English field names
- Extract ALL mentioned values
- Return language code (en, no, nn, de, fr, es, pt)

Respond with JSON: { "entities": [...], "language": "...", "requiresPrerequisites": [...] }`;

  let userMessage = `Extract entities from:\n\n${prompt}`;
  if (files.length > 0) {
    userMessage += `\n\nAttached files: ${files.map(f => f.filename).join(", ")}`;
  }

  const { object, durationMs } = await geminiGenerateStructured({
    model: modelId,
    system: systemPrompt,
    prompt: userMessage,
    schema: ExtractionResponseSchema,
    maxTokens: 2048,
  });

  // Build prerequisite tasks
  const prerequisites: { taskType: TaskType; entities: Record<string, unknown>[] }[] = [];
  if (object.requiresPrerequisites) {
    for (const prereq of object.requiresPrerequisites) {
      // Extract entities for the prerequisite from the same prompt
      const prereqEntities = extractPrerequisiteEntities(prereq.taskType as TaskType, object.entities);
      if (prereqEntities.length > 0) {
        prerequisites.push({
          taskType: prereq.taskType as TaskType,
          entities: prereqEntities,
        });
      }
    }
  }

  return {
    entities: object.entities,
    language: object.language,
    prerequisites,
    durationMs: durationMs ?? Math.round(performance.now() - start),
  };
}

/**
 * Extract prerequisite entities from the main entities.
 * E.g., if we need create_customer before send_invoice, extract customer data.
 */
function extractPrerequisiteEntities(
  prereqType: TaskType,
  mainEntities: Record<string, unknown>[],
): Record<string, unknown>[] {
  const firstEntity = mainEntities[0] ?? {};

  switch (prereqType) {
    case "create_customer":
      if (firstEntity.customerName || firstEntity.organizationNumber) {
        return [{
          name: firstEntity.customerName,
          organizationNumber: firstEntity.organizationNumber,
          email: firstEntity.customerEmail,
        }];
      }
      break;

    case "create_supplier":
      if (firstEntity.supplierName || firstEntity.organizationNumber) {
        return [{
          name: firstEntity.supplierName,
          organizationNumber: firstEntity.organizationNumber,
          email: firstEntity.supplierEmail,
        }];
      }
      break;

    case "create_employee":
      if (firstEntity.employeeFirstName || firstEntity.employeeLastName) {
        return [{
          firstName: firstEntity.employeeFirstName,
          lastName: firstEntity.employeeLastName,
          email: firstEntity.employeeEmail,
        }];
      }
      break;
  }

  return [];
}

/**
 * Build a complete task sequence from classification + extraction.
 */
export function buildTaskSequence(
  taskType: TaskType,
  extractionResult: ExtractionResult,
  rawPrompt: string,
): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  // Add prerequisites first
  for (const prereq of extractionResult.prerequisites) {
    tasks.push({
      taskType: prereq.taskType,
      entities: prereq.entities,
      language: extractionResult.language,
      rawPrompt,
    });
  }

  // Add main task
  tasks.push({
    taskType,
    entities: extractionResult.entities,
    language: extractionResult.language,
    rawPrompt,
  });

  return tasks;
}
