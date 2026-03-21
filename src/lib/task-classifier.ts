/**
 * Task classifier — matches competition prompts to exactly 30 task types.
 *
 * Each task type corresponds to a unique prompt template. The classifier
 * shows the LLM all 30 English templates and asks it to match the incoming
 * prompt (which may be in any of 7 languages) to the correct template.
 */

import { z } from "zod";
import { geminiGenerateStructured, type GeminiJsonSchema } from "./gemini.js";
import { ALL_TASK_TYPES, type TaskType } from "../types/index.js";

// ── The 30 prompt templates ───────────────────────────────────────────

export interface PromptTemplate {
  taskType: TaskType;
  template: string;
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    taskType: "create_customer",
    template: `Create the customer {COMPANY} with organization number {ORG}. The address is {ADDRESS}. Email: {EMAIL}.`,
  },
  {
    taskType: "create_employee",
    template: `We have a new employee named {PERSON}, born {DATE}. Create them as an employee with email {EMAIL} and start date {DATE}.`,
  },
  {
    taskType: "create_department",
    template: `Create three departments in Tripletex: "{NAME}", "{NAME}", and "{NAME}".`,
  },
  {
    taskType: "create_supplier",
    template: `Register the supplier {COMPANY} with organization number {ORG}. Email: {EMAIL}.`,
  },
  {
    taskType: "create_product",
    template: `Create the product "{NAME}" with product number {NUM}. The price is {AMOUNT} NOK excluding VAT, using the {PERCENT}% VAT rate.`,
  },
  {
    taskType: "create_project",
    template: `Create the project "{NAME}" linked to the customer {COMPANY} (org no. {ORG}). The project manager is {PERSON} ({EMAIL}).`,
  },
  {
    taskType: "create_invoice",
    template: `Create an invoice for the customer {COMPANY} (org no. {ORG}) with three product lines: {PRODUCT} ({PRODNUM}) at {AMOUNT} NOK with 25% VAT, {PRODUCT} ({PRODNUM}) at {AMOUNT} NOK with 15% VAT (food), and {PRODUCT} ({PRODNUM}) at {AMOUNT} NOK with 0% VAT (exempt).`,
  },
  {
    taskType: "send_invoice",
    template: `Create and send an invoice to the customer {COMPANY} (org no. {ORG}) for {AMOUNT} NOK excluding VAT. The invoice is for {PRODUCT}.`,
  },
  {
    taskType: "create_order",
    template: `Create an order for the customer {COMPANY} (org no. {ORG}) with the products {PRODUCT} ({PRODNUM}) at {AMOUNT} NOK and {PRODUCT} ({PRODNUM}) at {AMOUNT} NOK. Convert the order to an invoice and register full payment.`,
  },
  {
    taskType: "create_payment",
    template: `The customer {COMPANY} (org no. {ORG}) has an outstanding invoice for {AMOUNT} NOK excluding VAT for "{PRODUCT}". Register full payment on this invoice.`,
  },
  {
    taskType: "create_credit_note",
    template: `The customer {COMPANY} (org no. {ORG}) has complained about the invoice for "{PRODUCT}" ({AMOUNT} NOK excl. VAT). Issue a full credit note that reverses the entire invoice.`,
  },
  {
    taskType: "create_travel_expense",
    template: `Register a travel expense report for {PERSON} ({EMAIL}) for "{TRIP}". The trip lasted {DAYS} days with per diem (daily rate 800 NOK). Expenses: flight ticket {AMOUNT} NOK and taxi {AMOUNT} NOK.`,
  },
  {
    taskType: "create_payroll",
    template: `Run payroll for {PERSON} ({EMAIL}) for this month. The base salary is {AMOUNT} NOK. Add a one-time bonus of {AMOUNT} NOK on top of the base salary.`,
  },
  {
    taskType: "create_supplier_invoice",
    template: `We have received invoice {INVOICE_NO} from the supplier {COMPANY} (org no. {ORG}) for {AMOUNT} NOK including VAT. The amount relates to office services (account {ACCOUNT}). Register the supplier invoice with the correct input VAT (25%).`,
  },
  {
    taskType: "create_dimension",
    template: `Create a custom accounting dimension "{DIMENSION_NAME}" with the values "{VALUE}" and "{VALUE}". Then post a voucher on account {ACCOUNT} for {AMOUNT} NOK, linked to the dimension value "{VALUE}".`,
  },
  {
    taskType: "reverse_payment",
    template: `The payment from {COMPANY} (org no. {ORG}) for the invoice "{PRODUCT}" ({AMOUNT} NOK excl. VAT) was returned by the bank. Reverse the payment so the invoice shows the outstanding amount again.`,
  },
  {
    taskType: "project_fixed_price",
    template: `Set a fixed price of {AMOUNT} NOK on the project "{NAME}" for {COMPANY} (org no. {ORG}). The project manager is {PERSON} ({EMAIL}). Invoice the customer for {PERCENT}% of the fixed price as a milestone payment.`,
  },
  {
    taskType: "create_timesheet",
    template: `Log {HOURS} hours for {PERSON} ({EMAIL}) on the activity "{ACTIVITY}" in the project "{PROJECT}" for {COMPANY} (org no. {ORG}). Hourly rate: {RATE} NOK/h. Generate a project invoice to the customer based on the logged hours.`,
  },
  {
    taskType: "receipt_expense",
    template: `We need the {ITEM} expense from this receipt booked to department {DEPARTMENT}. Use the correct expense account based on the purchase, and ensure correct VAT treatment.`,
  },
  {
    taskType: "employee_onboarding_pdf",
    template: `You received an offer letter (see attached PDF) for a new employee. Complete the onboarding: create the employee, assign the correct department, set up employment details with percentage and annual salary, and configure standard working hours.`,
  },
  {
    taskType: "employee_contract_pdf",
    template: `You received an employment contract (see attached PDF). Create the employee in Tripletex with all the contract details: identity number, date of birth, department, occupation code, salary, employment percentage, and start date.`,
  },
  {
    taskType: "supplier_invoice_pdf",
    template: `You received a supplier invoice (see attached PDF). Register the invoice in Tripletex. Create the supplier if it does not exist. Use the correct expense account and input VAT.`,
  },
  {
    taskType: "bank_reconciliation",
    template: `Reconcile the bank statement (attached CSV) against open invoices in Tripletex. Match incoming payments to customer invoices and outgoing payments to supplier invoices. Handle partial payments correctly.`,
  },
  {
    taskType: "ledger_audit",
    template: `We have discovered errors in the general ledger for January and February 2026. Review all vouchers and find the 4 errors: a posting on the wrong account, a duplicate voucher, a missing VAT line, and an incorrect amount. Correct all errors with corrective entries.`,
  },
  {
    taskType: "ledger_analysis",
    template: `Total costs have risen significantly from January to February 2026. Analyze the general ledger and identify the three expense accounts with the largest increase. Create an internal project for each of the three accounts. Also create an activity for each project.`,
  },
  {
    taskType: "year_end_closing",
    template: `Perform the simplified year-end closing for 2025: 1) Calculate and post annual depreciation for three assets. 2) Reverse prepaid expenses. 3) Calculate and post the tax provision (22% of taxable income).`,
  },
  {
    taskType: "monthly_closing",
    template: `Perform the monthly closing for March 2026. Record the accrual reversal ({AMOUNT} NOK per month from account 1710 to expense). Record monthly depreciation. Verify trial balance is zero. Record a salary provision.`,
  },
  {
    taskType: "fx_payment",
    template: `We sent an invoice for {AMOUNT} EUR to {COMPANY} (org no. {ORG}) when the exchange rate was {RATE} NOK/EUR. The customer has now paid, but the rate is {RATE} NOK/EUR. Register the payment and post the exchange difference (disagio/agio) to the correct account.`,
  },
  {
    taskType: "project_lifecycle",
    template: `Execute the complete project lifecycle for "{NAME}" ({COMPANY}, org no. {ORG}): 1) Budget of {AMOUNT} NOK. 2) Register hours for multiple employees. 3) Register supplier cost. 4) Create an invoice to the customer for the project.`,
  },
  {
    taskType: "reminder_fee",
    template: `One of your customers has an overdue invoice. Find the overdue invoice and register a reminder fee of 50 NOK. Debit accounts receivable (1500), credit reminder income (3400). Also create an invoice for the reminder fee to the customer and send it. Additionally, register a partial payment of 5000 NOK on the overdue invoice.`,
  },
];

// ── Classifier system prompt ──────────────────────────────────────────

function buildClassifierPrompt(): string {
  const templateList = PROMPT_TEMPLATES.map(
    (t) => `${t.taskType}: "${t.template}"`,
  ).join("\n");

  return `You classify accounting task prompts into exactly one of 30 task types.

The prompts may be in English, Norwegian (bokmål/nynorsk), German, French, Spanish, or Portuguese — but they always match one of the 30 templates below. Variables like names, amounts, and dates differ between prompts but the structure is the same.

TEMPLATES:
${templateList}

RULES:
- Return ONLY the task type string, nothing else
- Every prompt matches exactly one template — there is no "unknown"
- Match by structure/intent, not by specific variable values
- The prompt language does NOT affect the task type

Output the task type string only. No JSON, no quotes, no explanation.`;
}

const CLASSIFIER_SYSTEM_PROMPT = buildClassifierPrompt();

// ── JSON schema for structured output ─────────────────────────────────

const ClassificationSchema = z.object({
  taskType: z.string(),
});

const CLASSIFICATION_JSON_SCHEMA: GeminiJsonSchema = {
  type: "object",
  properties: {
    taskType: {
      type: "string",
      description: "The task type ID — must be one of the 30 defined types",
      enum: ALL_TASK_TYPES as unknown as string[],
    },
  },
  required: ["taskType"],
};

// ── Public API ────────────────────────────────────────────────────────

export type ClassificationMethod = "llm" | "regex";

export interface ClassificationResult {
  type: TaskType;
  method: ClassificationMethod;
}

export interface ClassifyOptions {
  llmOnly?: boolean;
}

export async function classifyPrompt(
  prompt: string,
  options?: ClassifyOptions,
): Promise<ClassificationResult | null> {
  try {
    const llmPromise = geminiGenerateStructured({
      model: "gemini-3.1-pro-preview",
      system: CLASSIFIER_SYSTEM_PROMPT,
      prompt: prompt.slice(0, 2000),
      schema: ClassificationSchema,
      jsonSchema: CLASSIFICATION_JSON_SCHEMA,
      maxTokens: 64,
      maxRetries: 2,
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Classification timeout")), 8_000),
    );

    const { object } = await Promise.race([llmPromise, timeoutPromise]);
    const taskType = object.taskType?.trim();

    if (ALL_TASK_TYPES.includes(taskType as TaskType)) {
      return { type: taskType as TaskType, method: "llm" };
    }

    // Normalize and retry match
    const lower = taskType?.toLowerCase().replace(/[- ]/g, "_");
    const match = ALL_TASK_TYPES.find((id) => id === lower);
    if (match) return { type: match, method: "llm" };

    // LLM returned invalid type — fall back to regex
    if (options?.llmOnly) return null;
    return { type: classifyPromptRegex(prompt), method: "regex" };
  } catch {
    if (options?.llmOnly) return null;
    return { type: classifyPromptRegex(prompt), method: "regex" };
  }
}

// ── Batch classification ──────────────────────────────────────────────

export interface BatchClassificationStats {
  total: number;
  llm: number;
  regex: number;
  skipped: number;
}

export interface BatchClassifyOptions {
  concurrency?: number;
  verbose?: boolean;
  llmOnly?: boolean;
}

export async function classifyPromptsBatch(
  prompts: { id: string; prompt: string }[],
  options?: BatchClassifyOptions,
): Promise<{
  results: Map<string, TaskType>;
  stats: BatchClassificationStats;
}> {
  const concurrency = options?.concurrency ?? 5;
  const llmOnly = options?.llmOnly ?? false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const results = new Map<string, TaskType>();

  let completed = 0;
  let llmCount = 0;
  let regexCount = 0;
  let skippedCount = 0;
  const total = prompts.length;

  async function processOne(item: { id: string; prompt: string }): Promise<void> {
    const result = await classifyPrompt(item.prompt, { llmOnly });
    completed++;

    if (result === null) {
      skippedCount++;
      return;
    }

    results.set(item.id, result.type);
    if (result.method === "llm") llmCount++;
    else regexCount++;

    const methodTag = result.method === "llm" ? "LLM" : "regex";
    console.log(
      `[${completed}/${total}] ${result.type.padEnd(25)} (${methodTag}) | ${item.prompt.slice(0, 60).replace(/\n/g, " ")}`,
    );
  }

  for (let i = 0; i < prompts.length; i += concurrency) {
    const chunk = prompts.slice(i, i + concurrency);
    await Promise.all(chunk.map(processOne));
    if (i + concurrency < prompts.length) await sleep(150);
  }

  return {
    results,
    stats: { total, llm: llmCount, regex: regexCount, skipped: skippedCount },
  };
}

// ── Regex fallback ────────────────────────────────────────────────────

function re(pattern: string): RegExp {
  return new RegExp(pattern, "i");
}

export function classifyPromptRegex(prompt: string): TaskType {
  const p = prompt.toLowerCase();

  // Tier 3 — complex (check first, more specific patterns)
  if (re("\\b(reconcil|avstem|rapprocher|concili|abgleich)").test(p)) return "bank_reconciliation";
  if (re("\\b(year.?end|årsavslutning|cierre anual|clôture annuelle|jahresabschluss)").test(p)) return "year_end_closing";
  if (re("\\b(monthly clos|encerramento mensal|clôture mensuelle|monatsabschluss|månedsavslutning)").test(p)) return "monthly_closing";
  if (re("\\b(oppdaget feil|descubierto errores|discovered errors|errores en el libro|feil i hovedbok)").test(p)) return "ledger_audit";
  if (re("\\b(gestiegen|risen significantly|increased significantly|augmenté)").test(p) && re("\\b(hauptbuch|ledger|libro mayor)").test(p)) return "ledger_analysis";
  if (re("\\b(NOK\\/EUR|EUR\\/NOK|taxa de câmbio|wechselkurs|exchange rate|taux de change)").test(p)) return "fx_payment";
  if (re("\\b(ciclo de vida|lifecycle|prosjektsyklusen|cycle de vie)").test(p)) return "project_lifecycle";
  if (re("\\b(denne kvitteringen|ce reçu|this receipt|diesen beleg|este recibo|desta kvitteringa)").test(p)) return "receipt_expense";
  if (re("\\b(angebotsschreiben|offer letter|tilbudsbrev|lettre d.offre|carta de oferta)").test(p)) return "employee_onboarding_pdf";
  if (re("\\b(contrato de trabajo|employment contract|arbeidsavtale|contrat de travail|arbeidskontrakt)").test(p)) return "employee_contract_pdf";
  if (re("\\b(supplier invoice.*pdf|lieferantenrechnung.*pdf|fatura.*fornecedor.*pdf)").test(p)) return "supplier_invoice_pdf";
  if (re("\\b(received a supplier invoice|recebeu uma fatura de fornecedor|reçu une facture fournisseur|erhalten.*lieferantenrechnung)").test(p) && re("\\b(pdf|anexo|attached|beigefügt|adjunto)").test(p)) return "supplier_invoice_pdf";
  if (re("\\b(cargo por recordatorio|reminder.*fee|purregebyr|frais de rappel|Mahngebühr|reminder.*charge)").test(p)) return "reminder_fee";
  if (re("\\b(factura vencida|overdue invoice|überfällige rechnung|forfallen faktura)").test(p)) return "reminder_fee";

  // Tier 2 — multi-step
  if (re("\\b(returnert av banken|retourné par la banque|returned by the bank|von der bank zurückgebucht|returnert av bank)").test(p)) return "reverse_payment";
  if (re("\\b(returnert|zurückgebucht|retourné|reverse)").test(p) && re("\\b(betaling|zahlung|paiement|payment|pagamento)").test(p)) return "reverse_payment";
  if (re("\\b(fixed price|fast pris|precio fijo|prix fixe|festpris|preço fixo|prix forfaitaire)").test(p)) return "project_fixed_price";
  if (re("\\b(log|registrer|enregistrez|registre).*\\b(hours|timer|timar|heures|horas|stunden).*\\b(activit|aktivitet)").test(p)) return "create_timesheet";
  if (re("\\b(hemos recibido|received invoice|mottatt faktura|motteke faktura|reçu la facture|recebemos a fatura|erhalten.*rechnung)").test(p) && !re("pdf|attached|beigefügt|anexo|adjunto").test(p)) return "create_supplier_invoice";
  if (re("\\b(dimension|dimensjon|buchhaltungsdimension|dimensão|rekneskapsdimensjon)").test(p)) return "create_dimension";
  if (re("\\b(payroll|gehaltsabrechnung|lønn|nómina|paie|salário)").test(p) && re("\\b(bonus|prime|bónus)").test(p)) return "create_payroll";
  if (re("\\b(kjør lønn|run payroll|exécutez la paie|processe o salário|ejecute la nómina)").test(p)) return "create_payroll";
  if (re("\\b(travel.?expense|reiseregning|reiserekn|despesa de viagem|nota de gastos|frais de.*voyage|reisekosten)").test(p)) return "create_travel_expense";
  if (re("\\b(credit.?note|kreditnota|nota de crédito|gutschrift|note de crédit)").test(p)) return "create_credit_note";
  if (re("\\b(reklamert|ha reclamado|reclamou|a réclamé|has complained)").test(p)) return "create_credit_note";
  if (re("\\b(fatura pendente|facture? impayée?|pending invoice|ausstehende|utestående|outstanding invoice)").test(p)) return "create_payment";
  if (re("\\b(register.*payment|enregistrez.*paiement|registrer.*betaling|registre.*pagamento)").test(p)) return "create_payment";
  if (re("\\b(send|envie|senden|envía|enviar|envoyer)").test(p) && re("\\b(invoice|faktura|rechnung|factura|fatura)").test(p)) return "send_invoice";
  if (re("\\b(order|pedido|auftrag|commande|ordre)").test(p) && re("\\b(convert|konverter|wandeln|convierte|converta)").test(p)) return "create_order";
  if (re("\\b(three product lines|tres líneas|três linhas|drei Produkt|trois lignes|tre produktlinjer)").test(p)) return "create_invoice";
  if (re("\\b(invoice|faktura|rechnung|factura|fatura)").test(p) && re("\\b(create|opprett|crie|erstellen|crea|créez)").test(p)) return "create_invoice";

  // Tier 1 — simple CRUD
  if (re("\\b(project|prosjekt|proyecto|projekt|projet)").test(p) && re("\\b(create|opprett|erstellen|crie|crea|créez)").test(p)) return "create_project";
  if (re("\\b(product|produkt|producto|produit|produto)").test(p) && re("\\b(create|opprett|erstellen|crie|crea|créez)").test(p)) return "create_product";
  if (re("\\b(department|avdeling|abteilung|département|departamento)").test(p)) return "create_department";
  if (re("\\b(supplier|leverandør|fornecedor|proveedor|fournisseur|lieferant)").test(p)) return "create_supplier";
  if (re("\\b(customer|kunden?|cliente?|client)").test(p) && re("\\b(create|opprett|erstellen|crie|crea|créez)").test(p)) return "create_customer";
  if (re("\\b(employee|funcionário|ansatt|mitarbeiter|employé|tilsett|empleado)").test(p)) return "create_employee";

  // Last resort — default to create_customer (most common)
  return "create_customer";
}

// ── Language detection ────────────────────────────────────────────────

export function detectLanguage(prompt: string): string {
  const p = prompt.toLowerCase();
  if (re("\\b(créez|enregistrez|le paiement|facture impayée|fournisseur|l'activité|personnalisée|retourné|comptable|heures pour|paie de|annulez|clôture|dépense|reçu|frais de)").test(p)) return "fr";
  if (re("\\b(erstellen|rechnung|buchhaltung|auftrag|gutschrift|lieferant|registrieren|gehaltsabrechnung|benutzerdefinierte|wandeln|führen|grundgehalt|reisekosten|offene rechnung|angebotsschreiben|abteilung)").test(p)) return "de";
  if (re("\\b(crie|envie|fatura pendente|funcionário|salário|fornecedor|registe|processe|organização|pedido para o|dimensão|encerramento|despesa|preço fixo|reconcilie)").test(p)) return "pt";
  if (re("\\b(crea|establezca|factura|empleado|proveedor|pedido para el|nómina|bonificación|hemos recibido|convierte el pedido|ha reclamado|nota de gastos|cargo por recordatorio|descubierto errores|cierre anual)").test(p)) return "es";
  if (re("\\b(avdelingar|knytt|prosjektleiar|ordre for kunden|produkta|konverter|betalinga frå|motteke|reiserekning|rekneskapsdimensjon|tilsett)").test(p)) return "nn";
  if (re("\\b(opprett|registrer|kunden .+ as|leverandør|organisasjonsnummer|avdelinger|reiseregning|fakturaen for|kreditnota|timer for|grunnlønn|kjør lønn|utestående)").test(p)) return "no";
  if (re("\\b(create|send|register|set a fixed|convert the order|run payroll|log.*hours|reconcile|we have received|year.end|monthly clos)").test(p)) return "en";
  return "en";
}
