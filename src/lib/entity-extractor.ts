/**
 * Entity Extractor — Per-template variable extraction.
 *
 * After classification, we know which of the 30 templates the prompt matches.
 * Each template has specific variables (names, amounts, dates, etc.) that we
 * need to extract. The LLM is shown the template and asked to fill in values.
 */

import { z } from "zod";
import { openrouterGenerateStructured } from "./openrouter.js";
import type { ParsedTask, TaskType, FileAttachment } from "../types/index.js";
import { PROMPT_TEMPLATES } from "./task-classifier.js";
import { PDFParse } from "pdf-parse";

// ── Extraction response schema ───────────────────────────────────────

// Flexible prerequisite schema - accepts strings, objects with taskType, or any object
const PrerequisiteItemSchema = z.union([
  z.string().transform((s) => ({ taskType: s, reason: "" })),
  z.object({
    taskType: z.string(),
    reason: z.string().optional().default(""),
  }),
  z.record(z.unknown()).transform((obj) => ({
    taskType: String(obj.taskType ?? obj.type ?? obj.task ?? "unknown"),
    reason: String(obj.reason ?? ""),
  })),
]);

const ExtractionResponseSchema = z.object({
  entities: z.array(z.record(z.unknown())),
  language: z.string(),
  requiresPrerequisites: z.array(PrerequisiteItemSchema).optional(),
});

// ── Per-type extraction prompts ──────────────────────────────────────
// Each prompt tells the LLM exactly which variables to extract, matching
// the {VARIABLE} placeholders from the template.

const TASK_PROMPTS: Record<TaskType, string> = {
  create_customer: `Extract:
- name (company name, required)
- organizationNumber (org number)
- email
- phoneNumber
- postalAddress: { addressLine1, postalCode, city }

Preserve Unicode characters (å, ø, æ, ü) exactly.`,

  create_employee: `Extract:
- firstName, lastName (required)
- email
- phoneNumber, phoneNumberMobile
- dateOfBirth (YYYY-MM-DD)
- employeeNumber
- userType: "ADMINISTRATOR" if admin mentioned, "EXTENDED" if email given, "NO_ACCESS" otherwise
- startDate (YYYY-MM-DD)
- departmentName (if mentioned)

For multiple employees, return multiple entities.`,

  create_department: `Extract:
- name (required)
- departmentNumber (optional)

For multiple departments, return each as a separate entity.`,

  create_supplier: `Extract:
- name (company name, required)
- organizationNumber
- email
- phoneNumber`,

  create_product: `Extract:
- name (product name, required)
- number (product number/code)
- unitPrice (price excluding VAT)
- vatRate (percentage: 25, 15, 12, or 0; default 25)
- description (optional)`,

  create_project: `Extract:
- name (project name, required)
- customerName
- organizationNumber
- projectManagerFirstName, projectManagerLastName
- projectManagerEmail
- startDate, endDate (YYYY-MM-DD)
- description`,

  create_invoice: `Extract:
- customerName (required)
- organizationNumber
- invoiceDate, dueDate (YYYY-MM-DD)
- lines: array of { productName, productNumber, unitPrice, quantity, vatRate }

If only one product: use productName + amount instead of lines.
Add prerequisite create_customer if org number is given.`,

  send_invoice: `Extract:
- customerName (required)
- organizationNumber
- amount (excl. VAT)
- productName (what the invoice is for)
- invoiceDate, dueDate (YYYY-MM-DD)

Add prerequisite create_customer if org number is given.`,

  create_order: `Extract order metadata:
- customerName (required)
- organizationNumber
- orderDate, deliveryDate (YYYY-MM-DD)

Then product lines as additional entities:
- name (product name)
- productNumber
- unitPrice
- quantity (default 1)

Note: prompt may say "convert to invoice" or "register payment" — these are handled by the handler.`,

  create_payment: `Extract:
- customerName (required)
- organizationNumber
- amount (payment amount)
- paymentDate (YYYY-MM-DD)
- description (what the original invoice was for)

IMPORTANT: Do NOT add create_invoice prerequisite. The handler finds the existing invoice.`,

  create_credit_note: `Extract:
- customerName (required)
- organizationNumber
- amount (credit amount)
- productName (what the original invoice was for)
- date (YYYY-MM-DD)
- comment (reason for credit)

Add prerequisite create_customer.`,

  create_travel_expense: `Extract:
- employeeFirstName, employeeLastName (required)
- employeeEmail
- date (YYYY-MM-DD)
- description (trip name/destination)
- days (number of days for per diem)
- perDiemRate (daily rate, e.g. 800)
- costs: array of { amount, description } for each expense item

IMPORTANT: For per-diem, compute total = days × daily rate.`,

  create_payroll: `Extract:
- employeeFirstName, employeeLastName (required)
- employeeEmail
- baseSalary (monthly base salary amount)
- bonus (one-time bonus amount, if mentioned)`,

  create_supplier_invoice: `Extract:
- supplierName (required)
- organizationNumber
- amount (invoice total)
- amountIncludesVat (true if "including VAT" / "inkl. mva")
- accountNumber (expense account, e.g. 6300)
- vatRate (percentage, usually 25)
- invoiceNumber
- description

Add prerequisite create_supplier.`,

  create_dimension: `Extract:
- dimensionName (name of the custom dimension)
- dimensionValues: array of value names
- accountNumber (for voucher posting, if mentioned)
- amount (for voucher posting, if mentioned)
- linkedDimensionValue (which value to link the voucher to)`,

  reverse_payment: `Extract:
- customerName (required)
- organizationNumber
- amount (the payment amount being reversed)
- productName (what the original invoice was for)`,

  project_fixed_price: `Extract:
- projectName (required)
- customerName (required)
- organizationNumber
- projectManagerFirstName, projectManagerLastName
- projectManagerEmail
- fixedPrice (the fixed price amount in NOK)
- invoicePercentage (percentage to invoice, e.g. 75)`,

  create_timesheet: `Extract:
- employeeFirstName, employeeLastName (required - split the full name)
- employeeEmail (email address of the employee)
- hours (number of hours to log, as a number)
- activityName (the exact activity/task name from the prompt)
- projectName (the exact project name from the prompt)
- customerName (company name to invoice)
- organizationNumber (org number of the customer company)
- hourlyRate (NOK per hour, as a number)
- date (YYYY-MM-DD, use today if not specified)

IMPORTANT: Extract the activity name and project name EXACTLY as they appear in the prompt.`,

  receipt_expense: `Extract ALL details from the prompt and any attached receipt/PDF:
- itemDescription (what was purchased)
- departmentName (which department to book to)
- amount (total amount INCLUDING VAT, as a number like 6750)
- vatAmount (VAT amount as number, if shown separately on receipt)
- vatRate (as number like 25, NOT "25%")
- accountNumber (4-digit expense account, if specified)
- date (receipt date in YYYY-MM-DD format, if shown)
- supplierName (vendor/supplier name from receipt)

IMPORTANT: Extract the total amount and VAT from the attached receipt/PDF content.
Return amounts as pure numbers without currency symbols or formatting.`,

  employee_onboarding_pdf: `Extract ALL employee details from the prompt and any attached PDF content:
- firstName (required)
- lastName (required)
- email (if mentioned)
- phoneNumber (if mentioned)
- phoneNumberMobile (if mentioned)
- dateOfBirth (YYYY-MM-DD format)
- startDate (YYYY-MM-DD format, employment start date)
- salary (annual salary as number, e.g. 560000)
- position / title (job title)
- departmentName (department)
- employmentPercentage (e.g. 100)
- identityNumber (Norwegian personal ID number, 11 digits, if mentioned)

Extract ALL fields that appear in the text. The PDF content is inlined above.`,

  employee_contract_pdf: `Extract ALL contract details from the prompt and any attached PDF content:
- firstName (required)
- lastName (required)
- email (if mentioned)
- dateOfBirth (YYYY-MM-DD format)
- identityNumber (Norwegian personal ID, 11 digits)
- startDate (YYYY-MM-DD format)
- salary (annual salary as number)
- employmentPercentage (e.g. 100)
- departmentName (department)
- occupationCode (STYRK code if mentioned)
- position / title (job title)

Extract ALL fields that appear in the text. The PDF content is inlined above.`,

  supplier_invoice_pdf: `Extract ALL details from the prompt and any attached invoice PDF:
- supplierName (required)
- organizationNumber (supplier org number if shown)
- invoiceNumber (from the invoice)
- invoiceDate (YYYY-MM-DD)
- dueDate (YYYY-MM-DD)
- totalAmount (total including VAT, as number)
- vatAmount (VAT amount as number)
- netAmount (amount excluding VAT, as number)
- description (what was purchased/service description)
- accountNumber (4-digit expense account to debit, if known)

Extract all available information from the attached PDF content.`,

  bank_reconciliation: `Extract from the prompt AND any attached CSV/bank statement:
- periodStart, periodEnd (YYYY-MM-DD)
- bankAccountNumber (if specified)
- transactions: array of { date (YYYY-MM-DD), description, amount (positive=credit/inflow, negative=debit/outflow), reference }
- unmatchedItems: array of { date, description, amount, accountNumber (suggested ledger account), type ("bank_fee"|"interest"|"unmatched_payment"|"other") }
- bankBalance (closing balance from the statement if given)
- ledgerBalance (expected ledger balance if given)

Parse ALL rows from the CSV/bank statement. Each row is a transaction.
Common patterns: bank fees → account 7770, interest income → account 8040, interest expense → account 8140.
For payments that match invoices, include the invoice reference.`,

  ledger_audit: `Extract:
- date (YYYY-MM-DD for corrections)
- description (audit description)
- corrections: array of { accountNumber, wrongAmount, correctAmount, description }

Each correction represents an error found in the ledger that needs fixing.`,

  ledger_analysis: `Extract:
- periodStart, periodEnd (YYYY-MM-DD for comparison periods)
- accounts: array of { accountNumber, name, increase } for the top expense accounts
- projectPrefix (name prefix for the projects to create)

If specific accounts are not given, the handler will analyze the ledger.`,

  year_end_closing: `Extract:
- fiscalYear (e.g. 2025)
- assets: array of { name, accountNumber (4-digit asset account like 1200), originalValue (amount in NOK), depreciationRate (percentage like 20), depreciationAccountNumber (4-digit expense account like 6010), accumulatedDepreciationAccountNumber (4-digit contra-asset like 1209, if mentioned) }
- prepaidExpenses: array of { accountNumber (4-digit like 1710), amount (NOK), expenseAccountNumber (4-digit like 6300) }
- taxRate (percentage, e.g. 22)
- taxDebitAccount (4-digit, e.g. 8300 or 8700 if specified in prompt)
- taxCreditAccount (4-digit, e.g. 2500 or 2920 if specified in prompt)
- separateVouchers (boolean: true if the prompt says each depreciation should be a separate voucher)

CRITICAL RULES:
1. Account numbers are ALWAYS 4-digit (1000-9999). Never confuse amounts with account numbers.
2. If the prompt specifies "1209 for accumulated depreciation", set accumulatedDepreciationAccountNumber to 1209 for all assets.
3. If the prompt specifies tax accounts like "8700/2920", extract those as taxDebitAccount and taxCreditAccount.
4. If expenseAccountNumber for prepaid is not mentioned, use 6300 as default.
5. Common accounts: 1200/1210/1240/1250 (asset accounts), 1209 (accumulated depreciation), 1710 (prepaid), 6010/6020 (depreciation expense), 8300/8700 (tax expense), 2500/2920 (tax payable).

Extract ALL details.`,

  monthly_closing: `Extract:
- month (e.g. "2026-03" for March 2026)
- accrualReversals: array of { amount (number in NOK), fromAccount (4-digit account number), toAccount (4-digit account number), description }
- depreciationEntries: array of { amount (monthly depreciation in NOK), assetAccount (4-digit LEDGER account for the asset, e.g. 1200), depreciationAccount (4-digit expense account, e.g. 6010) }
- salaryProvision: { amount (number in NOK), debitAccount (4-digit, e.g. 5000), creditAccount (4-digit, e.g. 2900) }

CRITICAL RULES:
1. ALL account numbers MUST be exactly 4 digits (1000-9999). Never use monetary amounts as account numbers.
2. For depreciation: if the prompt says "anskaffelseskost 147250 kr", that 147250 is the ACQUISITION COST (a money amount), NOT an account. The assetAccount should be the balance sheet account (1200 for machinery, 1210 for furniture, etc.). Calculate monthly depreciation = acquisitionCost / years / 12.
3. If the prompt says "til kostkonto" or "expense account" without a number, use 6300 as default expense account.
4. If salary provision has no explicit amount, estimate a reasonable monthly salary (e.g. 50000 NOK).
5. Common accounts: 1200/1210 (assets), 1700/1710 (prepaid), 2900 (provisions), 5000 (salary), 6010/6020 (depreciation), 6300 (general expenses).

Extract ALL closing entries mentioned in the prompt.`,

  fx_payment: `Extract:
- customerName (required)
- organizationNumber
- invoiceAmountForeign (amount in foreign currency)
- currency (e.g. "EUR")
- invoiceRate (exchange rate when invoice was sent)
- paymentRate (exchange rate when payment received)
- productName (what the invoice was for)`,

  project_lifecycle: `Extract:
- projectName (required)
- customerName (required)
- organizationNumber
- budgetAmount (project budget)
- employees: array of { firstName, lastName, hours, hourlyRate }
- supplierCost: { supplierName, amount, description }
- invoiceAmount (amount to invoice customer)`,

  reminder_fee: `Extract:
- customerName (if specified)
- reminderFeeAmount (the fee amount, e.g. 50 NOK)
- partialPaymentAmount (partial payment amount on overdue invoice, if mentioned)
- debitAccount (e.g. 1500)
- creditAccount (e.g. 3400)`,
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
  _options?: { model?: string }
): Promise<ExtractionResult> {
  const taskPrompt = TASK_PROMPTS[taskType];
  const template = PROMPT_TEMPLATES.find((t) => t.taskType === taskType);

  const systemPrompt = `You extract structured entities from accounting task prompts.
The task type is: ${taskType}
${template ? `\nTemplate: "${template.template}"\n` : ""}
${taskPrompt}

Rules:
- All dates in YYYY-MM-DD format
- Preserve Unicode characters exactly (å, ø, æ, ü, ö, ñ, é, ã)
- Use English field names as specified above
- Extract ALL mentioned values — do not omit anything
- Return language code (en, no, nn, de, fr, es, pt)

Respond with JSON: { "entities": [...], "language": "...", "requiresPrerequisites": [...] }`;

  let userMessage = `Extract entities from:\n\n${prompt}`;
  if (files.length > 0) {
    userMessage += `\n\nAttached files: ${files
      .map((f) => f.filename)
      .join(", ")}`;
      
    for (const file of files) {
      if (file.content_base64) {
        const lowerName = file.filename.toLowerCase();
        if (lowerName.endsWith(".pdf")) {
          try {
            const b = Buffer.from(file.content_base64, "base64");
            const parser = new PDFParse(new Uint8Array(b));
            const pdfData = await parser.getText();
            userMessage += `\n\n--- Content of ${file.filename} ---\n${pdfData.text}\n--- End of ${file.filename} ---`;
          } catch (err) {
            console.error(`[EntityExtractor] Failed to parse PDF ${file.filename}:`, err);
          }
        } else if (lowerName.endsWith(".csv") || lowerName.endsWith(".txt")) {
          try {
            const text = Buffer.from(file.content_base64, "base64").toString("utf-8");
            userMessage += `\n\n--- Content of ${file.filename} ---\n${text}\n--- End of ${file.filename} ---`;
          } catch (err) {
            console.error(`[EntityExtractor] Failed to decode ${file.filename}:`, err);
          }
        }
      }
    }
  }

  let result;
  try {
    result = await openrouterGenerateStructured({
      model: "google/gemini-3.1-flash-lite-preview",
      system: systemPrompt,
      prompt: userMessage,
      schema: ExtractionResponseSchema,
      maxTokens: 2048,
    });
  } catch (llmError) {
    const msg = llmError instanceof Error ? llmError.message : String(llmError);
    console.error("[EntityExtractor] OpenRouter call failed:", msg);
    throw new Error(`Entity extraction LLM call failed: ${msg}`);
  }

  if (!result || typeof result !== "object") {
    console.error("[EntityExtractor] OpenRouter returned invalid result:", result);
    throw new Error("OpenRouter returned invalid result");
  }

  const { object, durationMs } = result;

  if (!object || !Array.isArray(object.entities)) {
    throw new Error(`Invalid extraction response: missing entities array`);
  }

  const prerequisites: {
    taskType: TaskType;
    entities: Record<string, unknown>[];
  }[] = [];
  if (object.requiresPrerequisites) {
    for (const rawPrereq of object.requiresPrerequisites) {
      const prereq = rawPrereq as { taskType: string; reason?: string };
      const prereqEntities = extractPrerequisiteEntities(
        prereq.taskType as TaskType,
        object.entities
      );
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
    durationMs,
  };
}

function extractPrerequisiteEntities(
  prereqType: TaskType,
  mainEntities: Record<string, unknown>[]
): Record<string, unknown>[] {
  const firstEntity = mainEntities[0] ?? {};

  switch (prereqType) {
    case "create_customer":
      if (firstEntity.customerName || firstEntity.organizationNumber) {
        return [
          {
            name: firstEntity.customerName,
            organizationNumber: firstEntity.organizationNumber,
            email: firstEntity.customerEmail,
          },
        ];
      }
      break;

    case "create_supplier":
      if (firstEntity.supplierName || firstEntity.organizationNumber) {
        return [
          {
            name: firstEntity.supplierName,
            organizationNumber: firstEntity.organizationNumber,
            email: firstEntity.supplierEmail,
          },
        ];
      }
      break;

    case "create_employee":
      if (firstEntity.employeeFirstName || firstEntity.employeeLastName) {
        return [
          {
            firstName: firstEntity.employeeFirstName,
            lastName: firstEntity.employeeLastName,
            email: firstEntity.employeeEmail,
          },
        ];
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
  rawPrompt: string
): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  for (const prereq of extractionResult.prerequisites) {
    tasks.push({
      taskType: prereq.taskType,
      entities: prereq.entities,
      language: extractionResult.language,
      rawPrompt,
    });
  }

  tasks.push({
    taskType,
    entities: extractionResult.entities,
    language: extractionResult.language,
    rawPrompt,
  });

  return tasks;
}
