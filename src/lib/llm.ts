import { z } from "zod";
import { config } from "./config.js";
import { geminiGenerateStructured } from "./gemini.js";
import type { FileAttachment, ParsedTask, ParsedTaskSequence, TaskType } from "../types/index.js";

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
  "create_payroll",
  "create_supplier_invoice",
  "create_dimension",
  "reverse_payment",
  "create_timesheet",
  "project_fixed_price",
  "receipt_expense",
  "employee_onboarding_pdf",
  "bank_reconciliation",
  "ledger_audit",
  "year_end_closing",
  "monthly_closing",
  "fx_payment",
  "project_lifecycle",
  "reminder_fee",
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

- create_employee: fields: firstName, lastName, email, phoneNumber, phoneNumberMobile, dateOfBirth, employeeNumber, userType, startDate (YYYY-MM-DD, employment start date)
  - userType: "ADMINISTRATOR" if the prompt says admin/administrator/administrador/administrateur/administratör/Verwalter/tilgangsrettighet: administrator. "EXTENDED" for regular users with email. "NO_ACCESS" if no email/login needed.
  - IMPORTANT: If the prompt asks to give someone admin rights, set userType to "ADMINISTRATOR".
  - startDate: The date when the employee starts working. Extract from prompt if mentioned (e.g. "data de início", "startdato", "fecha de inicio", "Anfangsdatum", "date de début", "start date").
- update_employee: fields: firstName, lastName (to find) + any updated fields
- create_customer: fields: name, email, organizationNumber, phoneNumber, postalAddress
- update_customer: fields: name (to find) + any updated fields
- create_product: fields: name, unitPrice, number, description, vatRate (percentage: 25, 15, 0, etc. — optional, defaults to 25%)
- create_department: fields: name, departmentNumber
- create_order: ONE entity with: customerName, orderDate (YYYY-MM-DD), deliveryDate (YYYY-MM-DD), ourReference, yourReference. Plus extra entities for products: name, quantity, unitPrice, productNumber (if given in parentheses like "Data Advisory (4083)").
- create_invoice: First entity is invoice metadata: customerName, invoiceDate (YYYY-MM-DD), dueDate (YYYY-MM-DD), comment.
  For a SINGLE product line: include productName, amount (excluding VAT) directly in the first entity.
  For MULTIPLE product lines (different items, different VAT rates): add additional entities after the first, each with: productName, unitPrice (excluding VAT), quantity (default 1), vatRate (percentage: 25, 15, 12, 0, etc.)
  Example with 3 lines: [{ customerName: "Acme" }, { productName: "Widget A", unitPrice: 1000, quantity: 2, vatRate: 25 }, { productName: "Widget B", unitPrice: 500, quantity: 1, vatRate: 15 }, { productName: "Widget C", unitPrice: 300, quantity: 1, vatRate: 0 }]
- send_invoice: same as create_invoice — creates and sends immediately. Always extract the amount and product/service description. Supports multiple product lines.
- create_payment: fields: customerName, organizationNumber, amount, paymentDate (YYYY-MM-DD), description/service (what the invoice is for)
  - IMPORTANT: If the prompt says the client "has" a pending/outstanding/unpaid invoice, the invoice ALREADY EXISTS in the sandbox. Return ONLY create_payment, NOT create_invoice + create_payment. The handler will find the existing invoice.
  - Keywords indicating existing invoice: "has a pending invoice", "tem uma fatura pendente", "tiene una factura pendiente", "hat eine offene Rechnung", "hat eine ausstehende Rechnung", "har en utestående faktura", "har ein uteståande faktura", "a une facture impayée", "a une facture en attente"
  - When the task is ONLY about registering/recording a payment on an existing invoice, use ONLY create_payment.
  - IMPORTANT: For "register a supplier" tasks, use create_supplier, NOT create_payment.
- create_credit_note: fields: customerName, organizationNumber, amount, productName/description (what the original invoice was for), date (YYYY-MM-DD), comment/reason
  - The handler will find or create the customer's invoice and issue a credit note against it.
  - IMPORTANT: If the prompt mentions a customer who "complained" or "reclaimed" an invoice, output create_customer (with org number) THEN create_credit_note. The credit note handler needs the customer to exist first.
- create_travel_expense: First entity is trip metadata: employeeFirstName, employeeLastName, date (YYYY-MM-DD), description (trip title). Additional entities are INDIVIDUAL cost items: amount, description (cost name, e.g. "Flybillett", "Taxi", "Diett"). Always separate each expense into its own entity.
  For per-diem/diett: ALWAYS compute the total (days × daily rate) and put the result as "amount". Do NOT use "comment" — the API field is "title" for the trip description.
  Example for "Reisen varte 4 dager med diett (dagsats 800 kr). Utlegg: flybillett 3800 kr og taxi 200 kr":
  → entities: [{employeeFirstName: "...", employeeLastName: "...", description: "Trip title"}, {amount: 3200, description: "Diett"}, {amount: 3800, description: "Flybillett"}, {amount: 200, description: "Taxi"}]
- delete_travel_expense: fields: employeeFirstName, employeeLastName OR travelExpenseId
- create_project: fields: name, projectManagerFirstName, projectManagerLastName, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), customerName, description
- create_voucher: fields: date (YYYY-MM-DD), description. Plus extra entities for postings: accountNumber, amount, type (DEBIT/CREDIT), description.
  - IMPORTANT: If the voucher must be LINKED to a custom dimension, accounting dimension, or other non-standard entity, use "unknown" for the ENTIRE task (dimension creation + voucher) so the agentic handler can maintain context.
- create_supplier: fields: name, email, organizationNumber, phoneNumber
  - IMPORTANT: "Register a supplier" / "Registrer leverandøren" / "Enregistrez le fournisseur" / "Registre o fornecedor" / "Registrieren Sie den Lieferanten" / "Registre el proveedor" = create_supplier. Do NOT use "unknown" for simple supplier creation.
- create_payroll: fields: employeeFirstName, employeeLastName, employeeEmail, baseSalary, bonus
  - ALWAYS use for payroll/salary processing tasks. The handler finds/creates the employee AND creates the voucher. Do NOT output a separate create_employee task before create_payroll — it handles employee lookup internally.
  - Keywords: "run payroll", "process salary", "exécutez la paie", "ejecute la nómina", "processe o salário", "führen Sie die Gehaltsabrechnung durch", "kjør lønn", "Gehaltsabrechnung", "lønnskostnad".
  - Extract baseSalary and bonus as separate numbers. If the prompt says "in addition to the base salary", the bonus is extra.
  - IMPORTANT: Even if the prompt mentions fallback strategies or alternative approaches (e.g. "if the salary API doesn't work, use manual vouchers"), STILL use create_payroll. The handler already implements the correct approach internally. Do NOT use "unknown" for payroll tasks.
- create_supplier_invoice: fields: supplierName, amount, amountIncludesVat (boolean), accountNumber, vatRate, invoiceNumber, description, organizationNumber
  - Use for registering incoming/supplier invoices. The handler creates a voucher (debit expense + debit input VAT + credit accounts payable with supplier reference).
  - Keywords: "register supplier invoice", "incoming invoice", "received invoice from supplier", "factura del proveedor", "facture fournisseur", "leverandørfaktura", "Lieferantenrechnung", "Register the supplier invoice", "We have received invoice".
  - CRITICAL: ANY prompt about receiving an invoice FROM a supplier = create_supplier_invoice. Do NOT use "unknown".
  - IMPORTANT: When both supplier creation AND supplier invoice registration are needed, split into create_supplier THEN create_supplier_invoice. The supplier must exist before the voucher.
- create_dimension: fields: dimensionName, dimensionValues (array of strings), accountNumber, amount, linkedDimensionValue
  - Use for creating custom accounting dimensions (optionally with a linked voucher).
  - When a prompt asks to create a custom dimension AND then create a voucher linked to it, return a SINGLE create_dimension task containing ALL information. Do NOT split into separate tasks.
  - CRITICAL: Do NOT confuse dimensions with departments. "rekneskapsdimensjon", "Buchhaltungsdimension", "dimensión contable", "dimension comptable" = create_dimension, NOT create_department.
  - Keywords: "custom accounting dimension", "benutzerdefinierte Buchhaltungsdimension", "dimension comptable", "dimensión contable", "regnskapsdimensjon", "rekneskapsdimensjon", "dimensão contábil", "fri dimensjon", "fri rekneskapsdimensjon".
- reverse_payment: fields: customerName, organizationNumber, amount, description/service (what the original invoice was for)
  - Use when a payment has been "returned by the bank" / "returnert av banken" / "retourné par la banque" / "zurückgebucht" and needs to be reversed.
  - Keywords: "reverse payment", "reverser betaling", "annulez le paiement", "stornieren Sie die Zahlung", "returnert av banken", "retourné par la banque", "returned by the bank", "zurückgebucht".
  - IMPORTANT: Include the customer org number if provided.
- create_timesheet: fields: employeeFirstName, employeeLastName, employeeEmail, hours, activityName, projectName, customerName, organizationNumber, hourlyRate, date (YYYY-MM-DD)
  - Use for logging/registering hours on a project activity.
  - Keywords: "log hours", "register hours", "registre horas", "enregistrez heures", "erfassen stunden", "registrer timer", "logg timer".
- project_fixed_price: fields: projectName, customerName, organizationNumber, projectManagerFirstName, projectManagerLastName, projectManagerEmail, fixedPrice, invoicePercentage
  - Use when setting a fixed price on a project and invoicing a percentage of it.
  - Keywords: "set a fixed price", "sett fastpris", "precio fijo", "prix fixe", "preço fixo", "festpris".
  - IMPORTANT: Extract the invoice percentage (e.g. "invoice 75%" → invoicePercentage: 75).
- receipt_expense: fields: expenseName, departmentName, accountNumber, amount, vatRate, vatAmount, date
  - Use when booking an expense from an attached receipt (image/PDF) to a department.
  - Keywords: "from this receipt", "denne kvitteringen", "ce reçu", "this receipt", "diesen Beleg", "este recibo".
  - The handler will read the receipt attachment and determine amounts/VAT.
  - Extract ALL amounts visible in the prompt (total, VAT, net) and the expense account number.
- employee_onboarding_pdf: fields: firstName, lastName, email, phoneNumber, startDate, salary, position, departmentName, userType
  - Use when onboarding a new employee from an attached PDF/offer letter.
  - Keywords: "offer letter", "tilbudsbrev", "Angebotsschreiben", "lettre d'offre", "carta de oferta", "ansettelsesavtale".
  - Extract ALL employee details from the prompt and/or PDF. The handler creates the employee with full details.
- bank_reconciliation: fields: date, bankBalance, ledgerBalance, adjustments (array of {accountNumber, amount, description, type: DEBIT/CREDIT})
  - Use for reconciling bank transactions against ledger entries.
  - Keywords: "reconcile", "avstemme", "rapprocher", "conciliar", "Abgleich", "bankavstemmelse".
  - Extract ALL adjustment entries, amounts, account numbers, and dates from the prompt.
- ledger_audit: fields: corrections (array of {accountNumber, wrongAmount, correctAmount, description}), date, originalVoucherDescription
  - Use for auditing/reviewing the general ledger and correcting erroneous entries.
  - Keywords: "audit", "errors in the ledger", "feil i hovedbok", "oppdaget feil", "errores en el libro", "descubierto errores".
  - Extract ALL corrections with account numbers and amounts.
- year_end_closing: fields: date, entries (array of {accountNumber, amount, type: DEBIT/CREDIT, description}), depreciationAmount, depreciationAssetAccount, depreciationExpenseAccount
  - Use for year-end closing: depreciation, accruals, closing revenue/expense accounts.
  - Keywords: "year-end closing", "årsavslutning", "årsoppgjør", "cierre anual", "clôture annuelle", "Jahresabschluss".
  - Extract ALL closing entries including depreciation amounts, account numbers, and any accruals.
- monthly_closing: fields: month, year, entries (array of {accountNumber, amount, type: DEBIT/CREDIT, description}), accruals (array of {accountNumber, amount, description})
  - Use for monthly closing: accruals, depreciation, prepaid expenses for a specific month.
  - Keywords: "monthly closing", "månedsavslutning", "clôture mensuelle", "encerramento mensal", "Monatsabschluss".
  - Extract ALL entries with account numbers, amounts, and the target month/year.
- fx_payment: fields: supplierName, organizationNumber, foreignAmount, foreignCurrency, exchangeRate, nokAmount, accountNumber, vatRate, description, invoiceNumber
  - Use for handling foreign-currency invoices or payments with exchange rate conversion.
  - Keywords: "exchange rate", "valutakurs", "taux de change", "taxa de câmbio", "Wechselkurs", "EUR", "USD", "GBP", "NOK/EUR".
  - IMPORTANT: Extract the foreign amount, currency code, exchange rate, AND the computed NOK amount. The handler creates a supplier invoice voucher with the converted amount.
- project_lifecycle: fields: projectName, customerName, organizationNumber, projectManagerFirstName, projectManagerLastName, projectManagerEmail, budget, hours, activityName, hourlyRate, invoicePercentage
  - Use for full project lifecycle: create project → register hours → invoice.
  - Keywords: "project lifecycle", "prosjektsyklusen", "ciclo de vida", "cycle de vie", "Projektzyklus".
  - Extract ALL details: project name, customer, manager, hours to log, budget, and invoicing details.
- reminder_fee: fields: customerName, organizationNumber, reminderFeeAmount, invoiceDescription, invoiceAmount
  - Use for registering a reminder fee/charge on an overdue invoice.
  - Keywords: "reminder fee", "purregebyr", "cargo por recordatorio", "frais de rappel", "Mahngebühr", "reminder charge".
  - Extract the reminder fee amount, customer details, and any invoice reference.
- unknown: For tasks that don't clearly match any of the above types. This includes asset management, company settings, contacts, divisions, activating modules, or other very unusual operations.
  - Do NOT use "unknown" when a dedicated handler exists. Check ALL task types above first.
  - CRITICAL: We now have 30 task types. Most accounting operations have a dedicated handler. Only use "unknown" as a last resort.

Rules:
- PRESERVE all Unicode characters exactly as they appear in the prompt (e.g. å, ø, æ, ü, ö, ñ, é, ã). Do NOT transliterate or anglicize names.
- All dates must be in YYYY-MM-DD format. Infer from context or use today if not given.
- For multiple entities of the same type (e.g. "create three departments"), return ONE task with each entity in the array.
- For orders: first entity = order metadata, additional entities = product lines.
- For vouchers: first entity = voucher metadata, additional entities = posting lines.
- Extract ALL field values mentioned. Use English field names.
- If the prompt involves a chain of operations (e.g. "create a customer and send them an invoice"), return multiple tasks in the correct execution order.
- IMPORTANT: Reuse references between tasks. If you create a customer "Acme Ltd" and then create an invoice for them, use the same customerName "Acme Ltd" in both tasks.
- CRITICAL: Do NOT force tasks into a wrong type. If the prompt asks to create a "custom accounting dimension" or "regnskapsdimensjon" or "rekneskapsdimensjon", use create_dimension (NOT create_department, NOT unknown). The create_dimension handler handles dimension creation + optional linked voucher in a single task.
- For "unknown" tasks: extract ALL information from the prompt into the entities array — names, values, numbers, dates, amounts, descriptions, account numbers, dimension names, etc. Put everything you can extract in the entity fields using descriptive field names.

Examples of correct parsing:

Example 1 - Payment on existing invoice (DO NOT create a new invoice):
Prompt: "O cliente Estrela Lda tem uma fatura pendente de 13650 NOK. Registe o pagamento."
→ tasks: [{ taskType: "create_payment", entities: [{ customerName: "Estrela Lda", amount: 13650 }] }]
WRONG: [{ taskType: "create_invoice" }, { taskType: "create_payment" }] — the invoice already exists!

Example 2 - Customer + invoice (MUST create customer first for fresh sandbox):
Prompt: "Crie e envie uma fatura ao cliente Porto Alegre Lda (org. nº 842889154) por 11200 NOK."
→ tasks: [{ taskType: "create_customer", entities: [{ name: "Porto Alegre Lda", organizationNumber: "842889154" }] }, { taskType: "send_invoice", entities: [{ customerName: "Porto Alegre Lda", amount: 11200 }] }]

Example 3 - Custom dimension + voucher (SINGLE create_dimension task):
Prompt: "Cree una dimensión contable personalizada Region con valores Nord-Norge y Vestlandet. Registre un asiento en cuenta 7100 por 34350 NOK vinculado a Nord-Norge."
→ tasks: [{ taskType: "create_dimension", entities: [{ dimensionName: "Region", dimensionValues: ["Nord-Norge", "Vestlandet"], accountNumber: 7100, amount: 34350, linkedDimensionValue: "Nord-Norge" }] }]

Example 4 - Employee with admin role:
Prompt: "Create employee Maria Svensson (maria@test.com) as an administrator."
→ tasks: [{ taskType: "create_employee", entities: [{ firstName: "Maria", lastName: "Svensson", email: "maria@test.com", userType: "ADMINISTRATOR" }] }]

Example 5 - Credit note (customer complained about invoice):
Prompt: "Kunden Fjelltopp AS (org.nr 950710241) har reklamert på fakturaen for Nettverksteneste (28100 kr). Opprett ei fullstendig kreditnota."
→ tasks: [{ taskType: "create_customer", entities: [{ name: "Fjelltopp AS", organizationNumber: "950710241" }] }, { taskType: "create_credit_note", entities: [{ customerName: "Fjelltopp AS", amount: 28100, productName: "Nettverksteneste" }] }]

Example 6 - Order → Invoice → Payment (full chain):
Prompt: "Create an order for Brightstone Ltd (org no. 971948981) with Data Advisory (4083) at 4050 NOK. Convert to invoice and register full payment."
→ tasks: [{ taskType: "create_customer", entities: [{ name: "Brightstone Ltd", organizationNumber: "971948981" }] }, { taskType: "create_order", entities: [{ customerName: "Brightstone Ltd" }, { name: "Data Advisory", quantity: 1, unitPrice: 4050 }] }, { taskType: "create_invoice", entities: [{ customerName: "Brightstone Ltd" }] }, { taskType: "create_payment", entities: [{ customerName: "Brightstone Ltd" }] }]
NOTE: For order→invoice→payment chains, always include all 4 task types. The handlers pass context (orderId, invoiceId) between tasks automatically.

Example 7 - Supplier registration (use dedicated handler, NOT unknown):
Prompt: "Registrer leverandøren Elvdal AS med organisasjonsnummer 994963309. E-post: faktura@elvdal.no."
→ tasks: [{ taskType: "create_supplier", entities: [{ name: "Elvdal AS", organizationNumber: "994963309", email: "faktura@elvdal.no" }] }]
WRONG: [{ taskType: "unknown", ... }] — this is a simple supplier creation, use create_supplier!

Example 8 - Three departments (batch in one task):
Prompt: "Erstellen Sie drei Abteilungen in Tripletex: Økonomi, Logistikk und Produksjon."
→ tasks: [{ taskType: "create_department", entities: [{ name: "Økonomi" }, { name: "Logistikk" }, { name: "Produksjon" }] }]

Example 9 - Supplier invoice / incoming invoice (create_supplier THEN create_supplier_invoice):
Prompt: "Hemos recibido la factura INV-2026-9187 del proveedor Montaña SL (org. nº 884646979) por 19500 NOK con IVA incluido. Servicios de oficina (cuenta 7300). Registre con IVA soportado (25 %)."
→ tasks: [{ taskType: "create_supplier", entities: [{ name: "Montaña SL", organizationNumber: "884646979" }] }, { taskType: "create_supplier_invoice", entities: [{ supplierName: "Montaña SL", invoiceNumber: "INV-2026-9187", amount: 19500, amountIncludesVat: true, accountNumber: 7300, vatRate: 25, description: "servicios de oficina" }] }]
NOTE: Always split supplier invoices into create_supplier + create_supplier_invoice. The supplier must exist before the voucher.

Example 10 - Payroll/salary processing:
Prompt: "Kjør lønn for Erik Nilsen (erik.nilsen@example.org) for denne måneden. Grunnlønn er 53350 kr. Legg til en engangsbonus på 11050 kr."
→ tasks: [{ taskType: "create_payroll", entities: [{ employeeFirstName: "Erik", employeeLastName: "Nilsen", employeeEmail: "erik.nilsen@example.org", baseSalary: 53350, bonus: 11050 }] }]
NOTE: The handler finds/creates the employee and uses voucher postings on salary accounts. Do NOT add a separate create_employee task before create_payroll.

Example 11 - Payroll with fallback instruction (STILL use create_payroll, not unknown):
Prompt: "Kjør lønn for Erik Nilsen (erik.nilsen@example.org). Grunnlønn 53350 kr. Bonus 11050 kr. Dersom lønns-API-et ikke fungerer, bruk manuelle bilag."
→ tasks: [{ taskType: "create_payroll", entities: [{ employeeFirstName: "Erik", employeeLastName: "Nilsen", employeeEmail: "erik.nilsen@example.org", baseSalary: 53350, bonus: 11050 }] }]
WRONG: [{ taskType: "create_employee" }, { taskType: "unknown" }] — create_payroll handles everything!

Example 12 - Supplier invoice in English (use create_supplier + create_supplier_invoice, NOT unknown):
Prompt: "We have received invoice INV-2026-3749 from the supplier Ridgepoint Ltd (org no. 902484981) for 65850 NOK including VAT. The amount relates to office services (account 6590). Register the supplier invoice with the correct input VAT (25%)."
→ tasks: [{ taskType: "create_supplier", entities: [{ name: "Ridgepoint Ltd", organizationNumber: "902484981" }] }, { taskType: "create_supplier_invoice", entities: [{ supplierName: "Ridgepoint Ltd", invoiceNumber: "INV-2026-3749", amount: 65850, amountIncludesVat: true, accountNumber: 6590, vatRate: 25, description: "office services" }] }]
WRONG: [{ taskType: "unknown", ... }] — create_supplier_invoice is the dedicated handler for this!

Example 13 - Nynorsk custom dimension (use create_dimension, NOT unknown or create_department):
Prompt: "Opprett ein fri rekneskapsdimensjon \"Prosjekttype\" med verdiane \"Utvikling\" og \"Internt\". Bokfør deretter eit bilag på konto 7000 for 39700 kr, knytt til dimensjonsverdien \"Internt\"."
→ tasks: [{ taskType: "create_dimension", entities: [{ dimensionName: "Prosjekttype", dimensionValues: ["Utvikling", "Internt"], accountNumber: 7000, amount: 39700, linkedDimensionValue: "Internt" }] }]
WRONG: [{ taskType: "unknown", ... }] — create_dimension is the dedicated handler!
WRONG: [{ taskType: "create_department" }, { taskType: "create_voucher" }] — dimensions are NOT departments!

Example 14 - Payroll in English (use create_payroll, NOT unknown):
Prompt: "Run payroll for Emily Lewis (emily.lewis@example.org) for this month. The base salary is 53400 NOK. Add a one-time bonus of 16900 NOK on top of the base salary."
→ tasks: [{ taskType: "create_payroll", entities: [{ employeeFirstName: "Emily", employeeLastName: "Lewis", employeeEmail: "emily.lewis@example.org", baseSalary: 53400, bonus: 16900 }] }]
WRONG: [{ taskType: "unknown", ... }] — create_payroll handles payroll!

Example 15 - Reverse payment (bank returned the payment):
Prompt: "Le paiement de Rivière SARL (nº org. 937044488) pour la facture \"Design web\" (33050 NOK HT) a été retourné par la banque. Annulez le paiement."
→ tasks: [{ taskType: "create_customer", entities: [{ name: "Rivière SARL", organizationNumber: "937044488" }] }, { taskType: "reverse_payment", entities: [{ customerName: "Rivière SARL", organizationNumber: "937044488", amount: 33050, description: "Design web" }] }]

Example 16 - Project fixed price with invoice percentage:
Prompt: "Set a fixed price of 362300 NOK on the project \\"Cloud Migration\\" for Cascata Ltd (org no. 829637286). The project manager is Beatriz Rodrigues (beatriz@example.org). Invoice 75% of the fixed price."
→ tasks: [{ taskType: "create_customer", entities: [{ name: "Cascata Ltd", organizationNumber: "829637286" }] }, { taskType: "project_fixed_price", entities: [{ projectName: "Cloud Migration", customerName: "Cascata Ltd", fixedPrice: 362300, invoicePercentage: 75, projectManagerFirstName: "Beatriz", projectManagerLastName: "Rodrigues", projectManagerEmail: "beatriz@example.org" }] }]

Example 17 - Log hours on a project (timesheet):
Prompt: "Register 7.5 hours for Maria Silva on the project \\"ERP Implementation\\", activity \\"Development\\", on 2026-03-15."
→ tasks: [{ taskType: "create_timesheet", entities: [{ employeeFirstName: "Maria", employeeLastName: "Silva", hours: 7.5, projectName: "ERP Implementation", activityName: "Development", date: "2026-03-15" }] }]`;

const SYSTEM_PROMPT_MINIMAL = `You parse Tripletex accounting prompts into JSON: tasks array (each with taskType and entities), and prompt language.
Known task types: create_employee, update_employee, create_customer, update_customer, create_product, create_department, create_invoice, send_invoice, create_payment, create_credit_note, create_order, create_travel_expense, delete_travel_expense, create_project, create_voucher, create_supplier, create_payroll, create_supplier_invoice, create_dimension, reverse_payment, create_timesheet, project_fixed_price, receipt_expense, employee_onboarding_pdf, bank_reconciliation, ledger_audit, year_end_closing, monthly_closing, fx_payment, project_lifecycle, reminder_fee, unknown.
Return one entity per distinct object (e.g. each department separately). For multi-step operations, return multiple tasks in dependency order.
Use create_payroll for salary/payroll tasks, create_supplier_invoice for incoming/supplier invoices, create_dimension for custom accounting dimensions.
Use bank_reconciliation for reconciliation tasks, year_end_closing/monthly_closing for closing entries, fx_payment for foreign currency, project_lifecycle for full project flows, reminder_fee for overdue charges, ledger_audit for correcting ledger errors, employee_onboarding_pdf for PDF-based onboarding.
Use "unknown" only for operations not in the list above (assets, company settings, module activation, etc.). Do NOT force into a wrong type. For unknown, extract all data into entities.`;

export const SYSTEM_PROMPT_VARIANTS = {
  default: SYSTEM_PROMPT,
  minimal: SYSTEM_PROMPT_MINIMAL,
} as const;

export type SystemPromptVariant = keyof typeof SYSTEM_PROMPT_VARIANTS;

export interface ParsePromptOptions {
  /** Gemini model id, e.g. gemini-2.5-flash */
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
  employee_onboarding_pdf: 1,
  create_customer: 1,
  create_supplier: 1,
  update_employee: 2,
  update_customer: 2,
  create_product: 2,
  create_order: 3,
  create_project: 3,
  create_voucher: 3,
  create_travel_expense: 3,
  create_payroll: 3,
  create_supplier_invoice: 3,
  create_dimension: 3,
  fx_payment: 3,
  bank_reconciliation: 3,
  ledger_audit: 3,
  year_end_closing: 3,
  monthly_closing: 3,
  project_lifecycle: 3,
  receipt_expense: 3,
  reminder_fee: 3,
  unknown: 3,
  create_invoice: 4,
  send_invoice: 4,
  delete_travel_expense: 4,
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
