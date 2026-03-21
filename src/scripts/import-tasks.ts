import "dotenv/config";
import Database from "better-sqlite3";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { testCases as existingCases } from "../eval/test-cases.js";
import db from "../lib/db.js";
import type { TestCase } from "../eval/types.js";
import type { TaskType } from "../types/index.js";

const EXTERNAL_DB_PATH = "C:/git/nmai-maskinkraft/tripletex/tasks.db";
const PROMOTED_FILE = join(import.meta.dirname, "../../data/verified/promoted-test-cases.json");

interface ExternalTask {
  task_id: string;
  prompt: string;
  language: string | null;
  status: string;
  elapsed_s: number | null;
  real_api_calls: number;
  real_api_errors: number;
  winning_plan: string | null;
  notes: string | null;
  files_count: number;
  tier: number | null;
  score: number | null;
  checks_detail: string | null;
  received_at: number;
}

interface PlanStep {
  tool: string;
  args?: Record<string, unknown>;
}

const TOOL_TO_TASK: Record<string, TaskType> = {
  create_employee: "create_employee",
  create_employment: "create_employee",
  update_employee: "update_employee",
  create_customer: "create_customer",
  update_customer: "update_customer",
  create_department: "create_department",
  create_supplier: "create_supplier",
  create_product: "create_product",
  create_order: "create_order",
  add_order_line: "create_order",
  create_invoice: "create_invoice",
  send_invoice: "send_invoice",
  create_project: "create_project",
  create_project_invoice: "create_project",
  set_project_hourly_rate: "create_project",
  create_voucher: "create_voucher",
  delete_voucher: "create_voucher",
  create_travel_expense: "create_travel_expense",
  add_travel_cost: "create_travel_expense",
  create_credit_note: "create_credit_note",
  create_invoice_payment: "create_payment",
  create_incoming_invoice: "unknown",
  create_accounting_dimension: "unknown",
  create_accounting_dimension_value: "unknown",
  create_salary_transaction: "unknown",
  create_timesheet_entry: "unknown",
  reverse_voucher: "unknown",
};

// These are "getter" tools that don't indicate the task type
const GETTER_TOOLS = new Set([
  "get_employees", "get_employee", "get_customers", "get_departments",
  "get_suppliers", "get_products", "get_orders", "get_invoices",
  "get_projects", "get_vouchers", "get_travel_expenses", "get_travel_costs",
  "get_travel_cost_categories", "get_modules", "enable_module", "get_accounts",
  "get_payment_types", "get_employment_types", "get_salary_types",
  "get_vat_types", "get_current_employee", "get_company_info",
  "get_timesheet_activities", "update_account",
]);

function detectLanguage(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/\b(créez|enregistrez|le paiement|facture impayée|fournisseur|l'activité|personnalisée|retourné|comptable|heures pour|paie de|taux horaire|annulez)\b/.test(lower)) return "fr";
  if (/\b(erstellen|rechnung|buchhaltung|auftrag|gutschrift|lieferant|registrieren|gehaltsabrechnung|benutzerdefinierte|wandeln|führen|grundgehalt|reisekosten|offene rechnung)\b/.test(lower)) return "de";
  if (/\b(crie|envie|fatura pendente|funcionário|salário|fornecedor|registe|processe|organização|pedido para o|cliente .+ lda)\b/.test(lower)) return "pt";
  if (/\b(crea|establezca|factura|empleado|proveedor|pedido para el|nómina|bonificación|hemos recibido|convierte el pedido|ha reclamado|nota de gastos)\b/.test(lower)) return "es";
  if (/\b(avdelingar|knytt|prosjektleiar|ordre for kunden|produkta|konverter|betalinga frå)\b/.test(lower)) return "nn";
  if (/\b(opprett|registrer|kunden .+ as|leverandør|organisasjonsnummer|avdelinger|reiseregning|fakturaen for|kreditnota|timar for)\b/.test(lower)) return "no";
  if (/\b(create|send|register|set a fixed|convert the order)\b/.test(lower)) return "en";
  return "en";
}

function detectPrimaryAction(prompt: string): TaskType {
  const lower = prompt.toLowerCase();

  // Payment patterns (most specific first)
  if (/\b(payment|paiement|zahlung|pago|pagamento|betaling)\b/.test(lower)
    && /\b(register|enregistr|registr|record)/.test(lower)) return "create_payment";
  if (/\b(facture? impayée?|fatura pendente|ausstehende rechnung|factura pendiente|utestående faktura|pending invoice|offene rechnung)\b/.test(lower)
    && /\b(register|enregistr|registr|record|paiement|payment|zahlung|betaling)/.test(lower)) return "create_payment";

  // Reverse payment patterns
  if (/\b(reverse|reverser|annulez|retourné|returnert|revert)\b/.test(lower)
    && /\b(payment|paiement|betaling|zahlung)\b/.test(lower)) return "unknown";

  // Incoming/supplier invoice
  if (/\b(hemos recibido|factura .+ proveedor|incoming invoice|leverandørfaktura)\b/.test(lower)) return "unknown";

  // Salary/payroll
  if (/\b(salaire|salary|payroll|salário|nómina|paie|gehalt|gehaltsabrechnung|lønn|lønnsslipp)\b/.test(lower)
    && /\b(exécutez|execute|processe|führen|registr)\b/.test(lower)) return "unknown";

  // Custom accounting dimensions
  if (/\b(dimension|dimensjon|buchhaltungsdimension|dimension comptable|dimensión contable)\b/.test(lower)) return "unknown";

  // Timesheet entries
  if (/\b(timesheet|timer|timar|heures pour|stunden)\b/.test(lower)
    && /\b(registr|enregistr|record|log)\b/.test(lower)) return "unknown";

  // Fixed price on project
  if (/\b(fixed price|fast pris|precio fijo|prix fixe|festpris)\b/.test(lower)) return "unknown";

  // Credit note
  if (/\b(credit.?note|kreditnota|nota de crédito|gutschrift|note de crédit|reklamert)\b/.test(lower)) return "create_credit_note";

  // Travel expense
  if (/\b(travel.?expense|reiseregning|despesa de viagem|nota de gastos de viaje|frais de voyage|reise)\b/.test(lower)) return "create_travel_expense";

  // Send invoice (create + send)
  if (/\b(send|envie|senden|envía|enviar|envoyer)\b/.test(lower)
    && /\b(invoice|faktura|rechnung|factura|fatura)\b/.test(lower)) return "send_invoice";

  // Create invoice (multi-line or single)
  if (/\b(invoice|faktura|rechnung|factura|fatura)\b/.test(lower)
    && /\b(create|opprett|crie|erstellen|crea|créez)\b/.test(lower)
    && !/\b(order|pedido|auftrag|commande|ordre)\b/.test(lower)) return "create_invoice";

  // Order (with optional conversion)
  if (/\b(order|pedido|auftrag|commande|ordre)\b/.test(lower)
    && /\b(create|opprett|crie|erstellen|crea|créez)\b/.test(lower)) return "create_order";
  if (/\b(convert.+order|konverter.+ordre|wandeln.+auftrag|convierte.+pedido)\b/.test(lower)) return "create_order";

  // Project
  if (/\b(project|prosjekt|proyecto|projekt|projet)\b/.test(lower)
    && /\b(create|opprett|erstellen|crie|crea|créez)\b/.test(lower)) return "create_project";

  // Product
  if (/\b(product|produkt|producto|produit)\b/.test(lower)
    && /\b(create|opprett|erstellen|crie|crea|créez)\b/.test(lower)) return "create_product";

  // Department
  if (/\b(department|avdeling|abteilung|département)\b/.test(lower)) return "create_department";

  // Supplier
  if (/\b(supplier|leverandør|fornecedor|proveedor|fournisseur|lieferant)\b/.test(lower)
    && /\b(create|registr|opprett|erstellen|crie|crea|enregistr)\b/.test(lower)) return "create_supplier";

  // Customer
  if (/\b(customer|kunden?|cliente?|client)\b/.test(lower)
    && /\b(create|opprett|crie|erstellen|crea|créez)\b/.test(lower)
    && !/\b(invoice|faktura|rechnung|factura|fatura|order|pedido|auftrag)\b/.test(lower)) return "create_customer";

  // Employee
  if (/\b(employee|funcionário|ansatt|mitarbeiter|employé)\b/.test(lower)
    && /\b(create|opprett|erstellen|crie|crea|créez)\b/.test(lower)) return "create_employee";

  return "unknown";
}

function detectTaskTypesFromPlan(plan: PlanStep[]): TaskType[] {
  const types: TaskType[] = [];
  for (const step of plan) {
    if (GETTER_TOOLS.has(step.tool)) continue;
    if (step.tool === "enable_module") continue;
    const mapped = TOOL_TO_TASK[step.tool];
    if (mapped && !types.includes(mapped)) {
      types.push(mapped);
    }
  }
  return types;
}

function extractEntities(prompt: string, primaryType: TaskType): Record<string, unknown>[] {
  const entities: Record<string, unknown>[] = [];

  const orgMatch = prompt.match(/(?:org\.?\s*(?:n[ºo°r]\.?|nr\.?|no\.?|number|nummer|número))\s*[:\s]?\s*(\d{9})/i);
  const emailMatch = prompt.match(/(?:e-?mail|e-?post)[:\s]+([^\s,]+@[^\s,]+)/i)
    || prompt.match(/\(([a-z][a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,})\)/i)
    || prompt.match(/\b([a-z][a-z0-9._-]+@example\.[a-z]{2,})\b/i);
  const amountMatch = prompt.match(/(\d[\d\s]*\d)\s*(?:NOK|kr)\b/i)
    || prompt.match(/(?:por|für|pour|for|over|über|de|à)\s+(\d[\d\s]*\d)\s*(?:NOK|kr)/i);

  const companyPatterns = [
    /([A-ZÆØÅÄÖÜ][\w\s]+?(?:AS|Ltd|GmbH|SL|Lda|SARL|AB))\b/,
  ];
  let companyName: string | null = null;
  for (const p of companyPatterns) {
    const m = prompt.match(p);
    if (m) { companyName = m[1].trim(); break; }
  }

  const personMatch = prompt.match(/(?:employee|funcionário|ansatt|Mitarbeiter|employé|para|for|de)\s+([A-ZÆØÅÄÖÜ][a-zæøåäöü]+)\s+([A-ZÆØÅÄÖÜ][a-zæøåäöü]+)/i);

  switch (primaryType) {
    case "create_employee":
    case "update_employee": {
      if (personMatch) {
        const e: Record<string, unknown> = { firstName: personMatch[1], lastName: personMatch[2] };
        if (emailMatch) e.email = emailMatch[1];
        entities.push(e);
      }
      break;
    }
    case "create_customer":
    case "update_customer": {
      if (companyName) {
        const e: Record<string, unknown> = { name: companyName };
        if (orgMatch) e.organizationNumber = orgMatch[1];
        if (emailMatch) e.email = emailMatch[1];
        entities.push(e);
      }
      break;
    }
    case "create_department": {
      const deptMatches = prompt.match(/"([^"]+)"/g);
      if (deptMatches) {
        for (const d of deptMatches) {
          entities.push({ name: d.replace(/"/g, "") });
        }
      }
      break;
    }
    case "create_supplier": {
      const supplierName = companyName;
      if (supplierName) {
        const e: Record<string, unknown> = { name: supplierName };
        if (orgMatch) e.organizationNumber = orgMatch[1];
        if (emailMatch) e.email = emailMatch[1];
        entities.push(e);
      }
      break;
    }
    case "create_product": {
      const nameMatch = prompt.match(/"([^"]+)"/);
      if (nameMatch) {
        const e: Record<string, unknown> = { name: nameMatch[1] };
        const numMatch = prompt.match(/(?:number|nummer|número|numéro)\s*(\d+)/i);
        if (numMatch) e.number = parseInt(numMatch[1], 10);
        entities.push(e);
      }
      break;
    }
    case "send_invoice":
    case "create_invoice": {
      if (companyName) entities.push({ name: companyName });
      if (amountMatch) entities.push({ amount: parseInt(amountMatch[1].replace(/\s/g, ""), 10) });
      break;
    }
    case "create_payment": {
      if (companyName) {
        const e: Record<string, unknown> = { customerName: companyName };
        if (amountMatch) e.amount = parseInt(amountMatch[1].replace(/\s/g, ""), 10);
        entities.push(e);
      }
      break;
    }
    case "create_credit_note": {
      if (companyName) entities.push({ name: companyName });
      if (amountMatch) entities.push({ amount: parseInt(amountMatch[1].replace(/\s/g, ""), 10) });
      break;
    }
    case "create_order": {
      if (companyName) entities.push({ customerName: companyName });
      break;
    }
    case "create_project": {
      const projMatch = prompt.match(/"([^"]+)"/);
      if (projMatch) entities.push({ name: projMatch[1] });
      break;
    }
    case "create_travel_expense": {
      if (personMatch) {
        entities.push({ employeeFirstName: personMatch[1], employeeLastName: personMatch[2] });
      }
      break;
    }
    default: {
      const allQuoted = prompt.match(/"([^"]+)"/g);
      if (allQuoted) {
        for (const q of allQuoted) entities.push({ name: q.replace(/"/g, "") });
      }
      if (amountMatch) entities.push({ amount: parseInt(amountMatch[1].replace(/\s/g, ""), 10) });
      break;
    }
  }

  if (entities.length === 0) entities.push({});
  return entities;
}

function determineTier(primaryType: TaskType, allTypes: TaskType[], prompt: string): 1 | 2 | 3 {
  if (allTypes.length >= 3) return 3;

  if (primaryType === "unknown") return 3;
  if (primaryType === "create_credit_note") return 3;
  if (primaryType === "create_payment") return 3;
  if (primaryType === "create_order") return 3;
  if (primaryType === "create_travel_expense") return 3;

  const lower = prompt.toLowerCase();

  // Invoice requiring new customer is tier 3
  if ((primaryType === "send_invoice" || primaryType === "create_invoice")
    && /\b(org|organisa)\b/.test(lower)) return 3;

  // Multi-line invoices
  if (/\b(product.?line|produktlinj|línea|drei|trois|tre|three|tre linjer|tres líneas|trois lignes)\b/.test(lower)) return 3;

  // Project with dependencies
  if (primaryType === "create_project" && /\b(org|organisa)\b/.test(lower)) return 3;
  if (primaryType === "create_project") return 2;

  // Multiple departments
  if (primaryType === "create_department") return 2;
  if (primaryType === "create_product") return 2;

  return 1;
}

function buildExpectedSequence(
  primaryType: TaskType,
  allTypes: TaskType[],
  prompt: string,
): { taskType: TaskType; entities: Record<string, unknown>[] }[] | undefined {
  const lower = prompt.toLowerCase();
  const orgMatch = prompt.match(/(?:org\.?\s*(?:n[ºo°r]\.?|nr\.?|no\.?|number|nummer|número))\s*[:\s]?\s*(\d{9})/i);
  const companyMatch = prompt.match(/([A-ZÆØÅÄÖÜ][\w\s]+?(?:AS|Ltd|GmbH|SL|Lda|SARL|AB))\b/);
  const customerName = companyMatch?.[1]?.trim();

  // send_invoice that requires creating a customer first
  if (primaryType === "send_invoice" && orgMatch && customerName) {
    return [
      { taskType: "create_customer", entities: [{ name: customerName, organizationNumber: orgMatch[1] }] },
      { taskType: "send_invoice", entities: [{ customerName }] },
    ];
  }

  // create_invoice that requires creating a customer first
  if (primaryType === "create_invoice" && orgMatch && customerName) {
    return [
      { taskType: "create_customer", entities: [{ name: customerName, organizationNumber: orgMatch[1] }] },
      { taskType: "create_invoice", entities: [{ customerName }] },
    ];
  }

  // create_credit_note: needs customer + invoice + credit note
  if (primaryType === "create_credit_note" && customerName) {
    const seq: { taskType: TaskType; entities: Record<string, unknown>[] }[] = [];
    if (orgMatch) {
      seq.push({ taskType: "create_customer", entities: [{ name: customerName, organizationNumber: orgMatch[1] }] });
    }
    seq.push({ taskType: "create_credit_note", entities: [{ customerName }] });
    return seq.length > 1 ? seq : undefined;
  }

  // create_order with customer (org number implies new customer)
  if (primaryType === "create_order" && orgMatch && customerName) {
    return [
      { taskType: "create_customer", entities: [{ name: customerName }] },
      { taskType: "create_order", entities: [{ customerName }] },
    ];
  }

  // create_project with customer
  if (primaryType === "create_project" && orgMatch && customerName) {
    const projMatch = prompt.match(/"([^"]+)"/);
    return [
      { taskType: "create_customer", entities: [{ name: customerName }] },
      { taskType: "create_project", entities: [{ name: projMatch?.[1] ?? "" }] },
    ];
  }

  // Multi-type from plan
  if (allTypes.length > 1 && allTypes[0] !== allTypes[allTypes.length - 1]) {
    return allTypes.map(tt => ({ taskType: tt, entities: [{}] }));
  }

  return undefined;
}

function makeId(prompt: string, language: string, primaryType: TaskType, index: number): string {
  const shortType = primaryType
    .replace("create_", "")
    .replace("send_", "send-")
    .replace("delete_", "del-")
    .replace("update_", "upd-");

  const companyMatch = prompt.match(/([A-ZÆØÅÄÖÜ][a-zæøåäöü]+)\s+(?:AS|Ltd|GmbH|SL|Lda|SARL|AB)\b/);
  const personMatch = prompt.match(/(?:employee|funcionário|para|for|de)\s+([A-ZÆØÅÄÖÜ][a-zæøåäöü]+)/i);
  const quotedMatch = prompt.match(/"([^"]{2,20})"/);

  const name = (companyMatch?.[1] || personMatch?.[1] || quotedMatch?.[1] || `t${index}`)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);

  return `${shortType}-${language}-${name}`;
}

function importToSolves(tasks: ExternalTask[]): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO solves (id, timestamp, prompt, files_count, base_url, parsed_sequence, api_calls, api_call_total, api_call_errors, elapsed_ms, success, error, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const task of tasks) {
    const timestamp = new Date(task.received_at * 1000).toISOString();
    const elapsedMs = task.elapsed_s ? Math.round(task.elapsed_s * 1000) : null;
    const success = task.status === "completed" && task.real_api_errors === 0 ? 1 : 0;
    const result = insert.run(
      `ext-${task.task_id}`, timestamp, task.prompt, task.files_count || 0, "",
      task.winning_plan, null, task.real_api_calls, task.real_api_errors,
      elapsedMs, success, task.notes, "external-import",
    );
    if (result.changes > 0) count++;
  }
  return count;
}

function isAlreadyCovered(prompt: string): boolean {
  return existingCases.some(
    (tc) => tc.prompt.trim().toLowerCase() === prompt.trim().toLowerCase(),
  );
}

async function main() {
  if (!existsSync(EXTERNAL_DB_PATH)) {
    console.error(`External DB not found: ${EXTERNAL_DB_PATH}`);
    process.exit(1);
  }

  const extDb = new Database(EXTERNAL_DB_PATH, { readonly: true });

  const tasks = extDb.prepare(`
    SELECT task_id, prompt, language, status, elapsed_s, real_api_calls, real_api_errors,
           winning_plan, notes, files_count, tier, score, checks_detail, received_at
    FROM tasks WHERE status = 'completed' ORDER BY received_at
  `).all() as ExternalTask[];

  console.log(`Found ${tasks.length} completed tasks in external DB`);

  console.log("\n=== Phase 1: Import to agent.db ===");
  const importCount = importToSolves(tasks);
  console.log(`Imported ${importCount} new records (${tasks.length - importCount} already existed)`);

  console.log("\n=== Phase 2: Generate test cases ===");

  const validTasks = tasks.filter(t => {
    if (t.prompt.trim().length < 15) return false;
    if (isAlreadyCovered(t.prompt)) return false;
    return true;
  });

  const seen = new Set<string>();
  const uniqueTasks = validTasks.filter(t => {
    const key = t.prompt.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`${uniqueTasks.length} unique novel prompts`);

  const usedIds = new Set(existingCases.map(tc => tc.id));
  const results: TestCase[] = [];

  for (let i = 0; i < uniqueTasks.length; i++) {
    const task = uniqueTasks[i];

    // Parse winning plan if available
    let planTypes: TaskType[] = [];
    if (task.winning_plan) {
      try {
        const plan = JSON.parse(task.winning_plan) as PlanStep[];
        planTypes = detectTaskTypesFromPlan(plan);
      } catch { /* ignore */ }
    }

    const language = detectLanguage(task.prompt);
    const primaryAction = detectPrimaryAction(task.prompt);

    // Use plan types if available, with primary action as the lead
    let allTypes: TaskType[];
    if (planTypes.length > 0) {
      allTypes = planTypes;
      // Make sure primary action is consistent
      if (!planTypes.includes(primaryAction) && primaryAction !== "unknown") {
        allTypes = [primaryAction, ...planTypes.filter(t => t !== primaryAction)];
      }
    } else {
      allTypes = [primaryAction];
    }

    const primaryType = primaryAction;
    const entities = extractEntities(task.prompt, primaryType);
    const tier = determineTier(primaryType, allTypes, task.prompt);

    const actualCalls = task.real_api_calls || 0;
    const actualErrors = task.real_api_errors || 0;
    const maxCalls = actualCalls > 0
      ? Math.max(actualCalls + Math.ceil(actualCalls * 0.5), actualCalls + 3)
      : tier === 1 ? 5 : tier === 2 ? 10 : 20;
    const maxErrors = Math.min(Math.max(actualErrors, 0) + 2, 5);

    const expectedSequence = buildExpectedSequence(primaryType, allTypes, task.prompt);
    const taskTypeAlts = allTypes.filter(t => t !== primaryType);

    let id = makeId(task.prompt, language, primaryType, i);
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${makeId(task.prompt, language, primaryType, i)}-${suffix++}`;
    }
    usedIds.add(id);

    const tc: TestCase = {
      id,
      prompt: task.prompt,
      language,
      tier,
      taskType: primaryType,
      ...(taskTypeAlts.length > 0 ? { taskTypeAlternatives: taskTypeAlts as TaskType[] } : {}),
      expectedEntities: entities,
      ...(expectedSequence ? { expectedTaskSequence: expectedSequence } : {}),
      expectedApiCalls: { max: maxCalls, maxErrors },
      ...(task.notes ? { notes: task.notes.slice(0, 200) } : {}),
    };

    results.push(tc);
    console.log(`  [${i + 1}/${uniqueTasks.length}] ${id} | ${primaryType} | tier:${tier} | max:${maxCalls}/${maxErrors}`);
  }

  const verifiedDir = join(import.meta.dirname, "../../data/verified");
  if (!existsSync(verifiedDir)) mkdirSync(verifiedDir, { recursive: true });

  writeFileSync(PROMOTED_FILE, JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} test cases to ${PROMOTED_FILE}`);
  console.log(`Total: ${existingCases.length} manual + ${results.length} promoted = ${existingCases.length + results.length}`);

  extDb.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
