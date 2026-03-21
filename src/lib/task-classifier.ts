/**
 * LLM-based task type classifier for competition prompts.
 *
 * Each task type has a name and description. The LLM picks the best match
 * from the enum, handling any language or phrasing variation naturally.
 */

import { z } from "zod";
import { geminiGenerateStructured, type GeminiJsonSchema } from "./gemini.js";

// ── Task type registry ──────────────────────────────────────────────

export interface TaskTypeDefinition {
  id: string;
  description: string;
}

export const TASK_TYPE_DEFINITIONS: TaskTypeDefinition[] = [
  {
    id: "create_employee",
    description:
      "Create/register a new employee in the system. May include personal info, email, start date, admin rights.",
  },
  {
    id: "update_employee",
    description:
      "Update an existing employee's information (name, email, role, department, etc.).",
  },
  {
    id: "create_customer",
    description:
      "Create/register a new customer. Includes name, org number, email, address.",
  },
  {
    id: "update_customer",
    description: "Update an existing customer's information.",
  },
  {
    id: "create_department",
    description:
      "Create one or more departments/divisions in the organization.",
  },
  {
    id: "create_supplier",
    description: "Register a new supplier/vendor with org number, email, etc.",
  },
  {
    id: "create_product",
    description:
      "Create a new product with name, product number, price, and VAT rate.",
  },
  {
    id: "create_order",
    description:
      "Create a sales order for a customer, possibly with multiple product lines. May include converting order to invoice.",
  },
  {
    id: "create_invoice",
    description:
      "Create an outgoing invoice for a customer (without sending it). May include product lines with different VAT rates.",
  },
  {
    id: "send_invoice",
    description:
      "Create AND send an invoice to a customer. The key distinction is the prompt explicitly asks to send/deliver the invoice.",
  },
  {
    id: "create_payment",
    description:
      "Register/record a payment on an existing or new invoice. The customer has a pending/outstanding invoice that needs payment.",
  },
  {
    id: "create_credit_note",
    description:
      "Issue a credit note against an invoice, typically because the customer complained/reclaimed.",
  },
  {
    id: "create_project",
    description:
      "Create a new project linked to a customer, with a project manager. Does NOT involve fixed pricing or invoicing percentage.",
  },
  {
    id: "create_voucher",
    description:
      "Create a manual accounting voucher with debit/credit postings to specific ledger accounts.",
  },
  {
    id: "create_travel_expense",
    description:
      "Register a travel expense report for an employee, with per-diem (diett), flight, taxi, hotel costs etc.",
  },
  {
    id: "create_payroll",
    description:
      "Run payroll/salary processing for an employee. Includes base salary and optional bonus.",
  },
  {
    id: "create_supplier_invoice",
    description:
      "Register an incoming invoice received FROM a supplier. Book with expense account, input VAT, and accounts payable.",
  },
  {
    id: "create_dimension",
    description:
      "Create a custom accounting dimension (not a department!) with named values, optionally followed by a voucher linked to one of the dimension values.",
  },
  {
    id: "reverse_payment",
    description:
      "Reverse/cancel a payment that was returned by the bank. The invoice should show outstanding balance again.",
  },
  {
    id: "create_timesheet",
    description:
      "Log/register hours worked by an employee on a project activity.",
  },
  {
    id: "project_fixed_price",
    description:
      "Set a fixed price on a project and invoice a percentage of it. Combines project creation with fixed-price billing.",
  },
  {
    id: "receipt_expense",
    description:
      "Book an expense from an attached receipt/image to a department and account.",
  },
  {
    id: "employee_onboarding_pdf",
    description:
      "Full employee onboarding from an attached PDF/offer letter — extract info and create employee with all details.",
  },
  {
    id: "bank_reconciliation",
    description:
      "Reconcile bank transactions against ledger entries, possibly from an attached CSV.",
  },
  {
    id: "ledger_audit",
    description:
      "Audit/review the general ledger for errors, find incorrect vouchers, and correct them.",
  },
  {
    id: "year_end_closing",
    description:
      "Perform year-end closing: depreciation, accruals, closing entries for revenue/expense accounts.",
  },
  {
    id: "monthly_closing",
    description:
      "Perform monthly closing: accruals, depreciation, prepaid expenses for a specific month.",
  },
  {
    id: "fx_payment",
    description:
      "Handle a foreign-currency invoice or payment with exchange rate conversion (e.g. EUR/NOK).",
  },
  {
    id: "project_lifecycle",
    description:
      "Full project lifecycle: create project with budget, register hours, then invoice. Multi-step process.",
  },
  {
    id: "reminder_fee",
    description: "Register a reminder fee/charge on an overdue invoice.",
  },
  {
    id: "unknown",
    description:
      "The prompt does not clearly match any of the above task types.",
  },
];

const TASK_TYPE_IDS = TASK_TYPE_DEFINITIONS.map((t) => t.id);

export type ClassifiedTaskType = (typeof TASK_TYPE_DEFINITIONS)[number]["id"];

// ── LLM classifier ─────────────────────────────────────────────────

const ClassificationSchema = z.object({
  taskType: z.string().optional().default(""),
  task_type: z.string().optional(),
  confidence: z.number().min(0).max(1).optional().default(0.5),
});

// JSON Schema for Gemini's controlled generation - guarantees valid JSON output
const CLASSIFICATION_JSON_SCHEMA: GeminiJsonSchema = {
  type: "object",
  properties: {
    taskType: {
      type: "string",
      description: "The task type ID from the available list",
    },
    confidence: {
      type: "number",
      description: "Confidence score between 0 and 1",
    },
  },
  required: ["taskType"],
};

const CLASSIFIER_SYSTEM_PROMPT = `Classify the prompt into a task type. Respond with ONLY a JSON object, nothing else.

Task types: ${TASK_TYPE_IDS.join(", ")}

Response format: {"taskType":"<id>","confidence":<0-1>}

Rules:
- Pick the most specific type matching the primary action
- Multi-step prompts: classify by the final goal
- send_invoice: only if explicitly asked to send/deliver
- reverse_payment: only for returned/rejected bank payments
- create_dimension: for custom accounting dimensions (not departments)
- project_fixed_price: requires both fixed price AND invoice percentage

Output ONLY the JSON. No prose. No "Here is". Just JSON.`;

export type ClassificationMethod = "llm" | "regex";

export interface ClassificationResult {
  type: ClassifiedTaskType;
  method: ClassificationMethod;
}

export interface ClassifyOptions {
  /** If true, skip regex fallback and return null on LLM failure */
  llmOnly?: boolean;
}

/**
 * Classify a prompt using the LLM. Returns the task type id and method used.
 * Falls back to regex-based classification if the LLM call fails or times out,
 * unless llmOnly is true (then returns null on failure).
 */
export async function classifyPrompt(
  prompt: string,
  options?: ClassifyOptions
): Promise<ClassificationResult | null> {
  try {
    const llmPromise = geminiGenerateStructured({
      model: "gemini-3.1-pro-preview",
      system: CLASSIFIER_SYSTEM_PROMPT,
      prompt: prompt.slice(0, 2000),
      schema: ClassificationSchema,
      jsonSchema: CLASSIFICATION_JSON_SCHEMA,
      maxTokens: 256,
      maxRetries: 2,
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Classification timeout")), 8_000)
    );

    const { object } = await Promise.race([llmPromise, timeoutPromise]);

    // Accept both camelCase (taskType) and snake_case (task_type) from LLM
    const taskType = object.taskType || object.task_type || "";
    if (TASK_TYPE_IDS.includes(taskType)) {
      return { type: taskType, method: "llm" };
    }

    // LLM returned an unexpected type — find the closest match
    const lower = taskType.toLowerCase().replace(/[- ]/g, "_");
    const match = TASK_TYPE_IDS.find((id) => id === lower);
    if (match) return { type: match, method: "llm" };

    // LLM returned invalid type
    if (options?.llmOnly) return null;
    return { type: classifyPromptRegex(prompt), method: "regex" };
  } catch {
    // LLM failed
    if (options?.llmOnly) return null;
    return { type: classifyPromptRegex(prompt), method: "regex" };
  }
}

export interface BatchClassificationStats {
  total: number;
  llm: number;
  regex: number;
  skipped: number;
}

export interface BatchClassifyOptions {
  concurrency?: number;
  verbose?: boolean;
  /** If true, skip regex fallback — prompts that fail LLM will not be included in results */
  llmOnly?: boolean;
}

/**
 * Classify a batch of prompts efficiently.
 * Uses one LLM call per prompt but runs them concurrently with rate limiting.
 * Returns both the results map and statistics about classification methods.
 */
export async function classifyPromptsBatch(
  prompts: { id: string; prompt: string }[],
  options?: BatchClassifyOptions
): Promise<{
  results: Map<string, ClassifiedTaskType>;
  stats: BatchClassificationStats;
}> {
  const concurrency = options?.concurrency ?? 5;
  const llmOnly = options?.llmOnly ?? false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const results = new Map<string, ClassifiedTaskType>();

  let completed = 0;
  let llmCount = 0;
  let regexCount = 0;
  let skippedCount = 0;
  const total = prompts.length;

  async function processOne(item: {
    id: string;
    prompt: string;
  }): Promise<void> {
    const result = await classifyPrompt(item.prompt, { llmOnly });
    completed++;

    if (result === null) {
      skippedCount++;
      console.log(
        `[${completed}/${total}] ${"(skipped)".padEnd(25)} (LLM failed) | ${item.prompt
          .slice(0, 60)
          .replace(/\n/g, " ")}`
      );
      return;
    }

    const { type, method } = result;
    results.set(item.id, type);

    if (method === "llm") {
      llmCount++;
    } else {
      regexCount++;
    }

    const methodTag = method === "llm" ? "LLM" : "regex";
    console.log(
      `[${completed}/${total}] ${type.padEnd(25)} (${methodTag}) | ${item.prompt
        .slice(0, 60)
        .replace(/\n/g, " ")}`
    );
  }

  // Process in chunks with cooldown to avoid rate limiting
  for (let i = 0; i < prompts.length; i += concurrency) {
    const chunk = prompts.slice(i, i + concurrency);
    await Promise.all(chunk.map(processOne));
    if (i + concurrency < prompts.length) {
      await sleep(150);
    }
  }

  const stats: BatchClassificationStats = {
    total,
    llm: llmCount,
    regex: regexCount,
    skipped: skippedCount,
  };

  const llmPct = total > 0 ? ((llmCount / total) * 100).toFixed(1) : "0";
  const regexPct = total > 0 ? ((regexCount / total) * 100).toFixed(1) : "0";
  const skippedPct = total > 0 ? ((skippedCount / total) * 100).toFixed(1) : "0";
  console.log(
    `[Classifier] Done: ${llmCount} LLM (${llmPct}%), ${regexCount} regex (${regexPct}%)` +
      (skippedCount > 0 ? `, ${skippedCount} skipped (${skippedPct}%)` : "")
  );

  return { results, stats };
}

// ── Regex fallback (used when LLM is unavailable) ───────────────────

function re(pattern: string): RegExp {
  return new RegExp(pattern, "i");
}

export function classifyPromptRegex(prompt: string): ClassifiedTaskType {
  const p = prompt.toLowerCase();

  if (/^test\b/.test(p.trim()) && p.trim().length < 30) return "unknown";
  if (re("\\b(reconcil|avstem|rapprocher|concili|abgleich)").test(p))
    return "bank_reconciliation";
  if (
    re(
      "\\b(year.?end|årsavslutning|cierre anual|clôture annuelle|jahresabschluss|årsoppgjør)"
    ).test(p)
  )
    return "year_end_closing";
  if (
    re(
      "\\b(clôture mensuelle|encerramento mensal|monthly clos|monatsabschluss|månedsavslutning)"
    ).test(p)
  )
    return "monthly_closing";
  if (
    re(
      "\\b(feil i hovedbok|oppdaget feil|errores en el libro|errors in the ledger|descubierto errores)"
    ).test(p)
  )
    return "ledger_audit";
  if (
    re(
      "\\b(NOK\\/EUR|EUR\\/NOK|taxa de câmbio|wechselkurs|taux de change|exchange rate)"
    ).test(p)
  )
    return "fx_payment";
  if (re("\\b(ciclo de vida|lifecycle|prosjektsyklusen|cycle de vie)").test(p))
    return "project_lifecycle";
  if (
    re(
      "\\b(denne kvitteringen|ce reçu|this receipt|diesen beleg|este recibo)"
    ).test(p)
  )
    return "receipt_expense";
  if (
    re(
      "\\b(angebotsschreiben|offer letter|tilbudsbrev|lettre d.offre|carta de oferta)"
    ).test(p)
  )
    return "employee_onboarding_pdf";
  if (
    re(
      "\\b(cargo por recordatorio|reminder.*charge|purregebyr|frais de rappel|Mahngebühr)"
    ).test(p)
  )
    return "reminder_fee";
  if (
    re("\\b(returnert|zurückgebucht|stornieren|retourné|reverse)").test(p) &&
    re("\\b(betaling|zahlung|paiement|payment)").test(p)
  )
    return "reverse_payment";
  if (
    re(
      "\\b(returnert av banken|retourné par la banque|returned by the bank|von der bank zurückgebucht)"
    ).test(p)
  )
    return "reverse_payment";
  if (
    re(
      "\\b(hemos recibido|received invoice|mottatt faktura|motteke faktura|reçu la facture|recebemos a fatura)"
    ).test(p)
  )
    return "create_supplier_invoice";
  if (
    re("\\b(erhalten.*rechnung|rechnung.*erhalten|lieferantenrechnung)").test(p)
  )
    return "create_supplier_invoice";
  if (re("\\b(payroll|gehaltsabrechnung|lønnskjøring|nómina)").test(p))
    return "create_payroll";
  if (
    re("\\b(kjør lønn|run payroll|exécutez la paie|processe o salário)").test(p)
  )
    return "create_payroll";
  if (
    re(
      "\\b(grundgehalt|grunnlønn|base salary|salaire de base|salário base)"
    ).test(p) &&
    re("\\b(bonus|prime|bónus)").test(p)
  )
    return "create_payroll";
  if (
    re(
      "\\b(dimension|dimensjon|buchhaltungsdimension|dimensão contabilística|rekneskapsdimensjon)"
    ).test(p)
  )
    return "create_dimension";
  if (
    re(
      "\\b(fixed price|fast pris|precio fijo|prix fixe|festpris|preço fixo)"
    ).test(p)
  )
    return "project_fixed_price";
  if (re("\\b(hours for|horas para|heures pour|stunden für|timer for)").test(p))
    return "create_timesheet";
  if (
    re(
      "\\b(credit.?note|kreditnota|nota de crédito|gutschrift|note de crédit)"
    ).test(p)
  )
    return "create_credit_note";
  if (
    re("\\b(reklamert|ha reclamado|reclamou|a réclamé|has complained)").test(p)
  )
    return "create_credit_note";
  if (
    re(
      "\\b(travel.?expense|reiseregning|reiserekn|despesa de viagem|nota de gastos|frais de.*voyage|reisekosten)"
    ).test(p)
  )
    return "create_travel_expense";
  if (
    re("\\b(payment|paiement|zahlung|pago|pagamento|betaling)").test(p) &&
    re("\\b(register|enregistr|registr|record|registe)").test(p)
  )
    return "create_payment";
  if (
    re(
      "\\b(fatura pendente|facture? impayée?|pending invoice|ausstehende rechnung|utestående faktura)"
    ).test(p)
  )
    return "create_payment";
  if (
    re("\\b(send|envie|senden|envía|enviar|envoyer)").test(p) &&
    re("\\b(invoice|faktura|rechnung|factura|fatura)").test(p)
  )
    return "send_invoice";
  if (
    re("\\b(invoice|faktura|rechnung|factura|fatura)").test(p) &&
    re("\\b(create|opprett|crie|erstellen|crea|créez)").test(p)
  )
    return "create_invoice";
  if (re("\\b(order|pedido|auftrag|commande|ordre|bestilling)").test(p))
    return "create_order";
  if (
    re("\\b(project|prosjekt|proyecto|projekt|projet)").test(p) &&
    re("\\b(create|opprett|erstellen|crie|crea)").test(p)
  )
    return "create_project";
  if (
    re("\\b(product|produkt|producto|produit|produto)").test(p) &&
    re("\\b(create|opprett|erstellen|crie|crea)").test(p)
  )
    return "create_product";
  if (re("\\b(department|avdeling|abteilung|département|departamento)").test(p))
    return "create_department";
  if (
    re(
      "\\b(supplier|leverandør|fornecedor|proveedor|fournisseur|lieferant)"
    ).test(p)
  )
    return "create_supplier";
  if (re("\\b(customer|kunden?|cliente?|client)").test(p))
    return "create_customer";
  if (
    re(
      "\\b(employee|funcionário|ansatt|mitarbeiter|employé|tilsett|empleado)"
    ).test(p)
  )
    return "create_employee";
  if (
    re(
      "\\b(nouvel employé|novo funcionário|neuen mitarbeiter|new employee)"
    ).test(p)
  )
    return "create_employee";
  return "unknown";
}

// ── Language detection (regex is fine for this) ─────────────────────

export function detectLanguage(prompt: string): string {
  const p = prompt.toLowerCase();
  if (
    re(
      "\\b(créez|enregistrez|le paiement|facture impayée|fournisseur|l'activité|personnalisée|retourné|comptable|heures pour|paie de|taux horaire|annulez|clôture|dépense|reçu|frais de)"
    ).test(p)
  )
    return "fr";
  if (
    re(
      "\\b(erstellen|rechnung|buchhaltung|auftrag|gutschrift|lieferant|registrieren|gehaltsabrechnung|benutzerdefinierte|wandeln|führen|grundgehalt|reisekosten|offene rechnung|angebotsschreiben|abteilung)"
    ).test(p)
  )
    return "de";
  if (
    re(
      "\\b(crie|envie|fatura pendente|funcionário|salário|fornecedor|registe|processe|organização|pedido para o|cliente .+ lda|dimensão|encerramento|despesa|preço fixo|reconcilie)"
    ).test(p)
  )
    return "pt";
  if (
    re(
      "\\b(crea|establezca|factura|empleado|proveedor|pedido para el|nómina|bonificación|hemos recibido|convierte el pedido|ha reclamado|nota de gastos|cargo por recordatorio|descubierto errores|cierre anual)"
    ).test(p)
  )
    return "es";
  if (
    re(
      "\\b(avdelingar|knytt|prosjektleiar|ordre for kunden|produkta|konverter|betalinga frå|motteke|reiserekning|rekneskapsdimensjon|tilsett|oppdaget feil)"
    ).test(p)
  )
    return "nn";
  if (
    re(
      "\\b(opprett|registrer|kunden .+ as|leverandør|organisasjonsnummer|avdelinger|reiseregning|fakturaen for|kreditnota|timer for|grunnlønn|kjør lønn|utestående)"
    ).test(p)
  )
    return "no";
  if (
    re(
      "\\b(create|send|register|set a fixed|convert the order|run payroll|log.*hours|reconcile|we have received|year.end|monthly clos)"
    ).test(p)
  )
    return "en";
  return "en";
}
