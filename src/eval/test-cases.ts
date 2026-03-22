import type { TestCase } from "./types.js";

/**
 * 30 canonical test cases — one per task type.
 *
 * Each case uses an English prompt matching the competition template structure.
 * Expected entities reflect what the entity extractor should produce.
 * API call bounds are targets: zero errors, tight call counts.
 *
 * For file-based types (PDF/CSV), requiresFile is set. These need file fixtures
 * to execute; without files the handler will fail (useful signal for tracking).
 */
export const testCases: TestCase[] = [
  // ═══════════════════════════════════════════════════════════════════
  // TIER 1 — Simple CRUD (5 types)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: "canonical-create_customer",
    prompt:
      "Create the customer Nordfjord Consulting AS with organization number 987654321. The address is Storgata 10, 0001 Oslo. Email: post@nordfjord.no.",
    language: "en",
    tier: 1,
    taskType: "create_customer",
    expectedEntities: [
      {
        name: "Nordfjord Consulting AS",
        organizationNumber: "987654321",
        email: "post@nordfjord.no",
      },
    ],
    expectedApiCalls: { max: 1, maxErrors: 0 },
  },

  {
    id: "canonical-create_employee",
    prompt:
      "We have a new employee named Erik Hansen, born 1990-05-15. Create them as an employee with email erik.hansen@example.com and start date 2026-04-01.",
    language: "en",
    tier: 1,
    taskType: "create_employee",
    expectedEntities: [
      {
        firstName: "Erik",
        lastName: "Hansen",
        email: "erik.hansen@example.com",
      },
    ],
    expectedApiCalls: { max: 1, maxErrors: 0 },
  },

  {
    id: "canonical-create_department",
    prompt:
      'Create three departments in Tripletex: "Salg", "Utvikling", and "HR".',
    language: "en",
    tier: 1,
    taskType: "create_department",
    expectedEntities: [
      { name: "Salg" },
      { name: "Utvikling" },
      { name: "HR" },
    ],
    expectedApiCalls: { max: 1, maxErrors: 0 },
  },

  {
    id: "canonical-create_supplier",
    prompt:
      "Register the supplier Kontorservice AS with organization number 912345678. Email: faktura@kontorservice.no.",
    language: "en",
    tier: 1,
    taskType: "create_supplier",
    expectedEntities: [
      {
        name: "Kontorservice AS",
        organizationNumber: "912345678",
        email: "faktura@kontorservice.no",
      },
    ],
    expectedApiCalls: { max: 1, maxErrors: 0 },
  },

  {
    id: "canonical-create_product",
    prompt:
      'Create the product "Premium Konsulentpakke" with product number 1001. The price is 4500 NOK excluding VAT, using the 25% VAT rate.',
    language: "en",
    tier: 1,
    taskType: "create_product",
    expectedEntities: [
      {
        name: "Premium Konsulentpakke",
        number: "1001",
        unitPrice: 4500,
        vatRate: 25,
      },
    ],
    expectedApiCalls: { max: 1, maxErrors: 0 },
  },

  // ═══════════════════════════════════════════════════════════════════
  // TIER 2 — Multi-step (13 types)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: "canonical-create_project",
    prompt:
      'Create the project "Nettside Redesign" linked to the customer Nordlys AS (org no. 876543219). The project manager is Kari Larsen (kari.larsen@example.com).',
    language: "en",
    tier: 2,
    taskType: "create_project",
    expectedEntities: [
      {
        name: "Nettside Redesign",
        customerName: "Nordlys AS",
        organizationNumber: "876543219",
        projectManagerEmail: "kari.larsen@example.com",
      },
    ],
    expectedApiCalls: { max: 4, maxErrors: 0 },
  },

  {
    id: "canonical-create_invoice",
    prompt:
      "Create an invoice for the customer Bergen Handel AS (org no. 811222333) with three product lines: Konsulentarbeid (K-001) at 15000 NOK with 25% VAT, Lunsj catering (K-002) at 3000 NOK with 15% VAT (food), and Frivillig arbeid (K-003) at 5000 NOK with 0% VAT (exempt).",
    language: "en",
    tier: 2,
    taskType: "create_invoice",
    expectedEntities: [
      {
        customerName: "Bergen Handel AS",
        organizationNumber: "811222333",
      },
    ],
    expectedApiCalls: { max: 6, maxErrors: 0 },
    notes: "Three products with different VAT rates: 25%, 15% (food), 0% (exempt).",
  },

  {
    id: "canonical-send_invoice",
    prompt:
      "Create and send an invoice to the customer Vestland Tech AS (org no. 922333444) for 25000 NOK excluding VAT. The invoice is for Systemutvikling.",
    language: "en",
    tier: 2,
    taskType: "send_invoice",
    expectedEntities: [
      {
        customerName: "Vestland Tech AS",
        organizationNumber: "922333444",
        amount: 25000,
      },
    ],
    expectedApiCalls: { max: 7, maxErrors: 0 },
  },

  {
    id: "canonical-create_order",
    prompt:
      "Create an order for the customer Havbris AS (org no. 933444555) with the products Rådgivning (R-100) at 12000 NOK and Prosjektledelse (R-200) at 8000 NOK. Convert the order to an invoice and register full payment.",
    language: "en",
    tier: 2,
    taskType: "create_order",
    expectedEntities: [
      {
        customerName: "Havbris AS",
        organizationNumber: "933444555",
      },
    ],
    expectedApiCalls: { max: 4, maxErrors: 0 },
  },

  {
    id: "canonical-create_payment",
    prompt:
      'The customer Solberg Industri AS (org no. 944555666) has an outstanding invoice for 18000 NOK excluding VAT for "IT-tjenester". Register full payment on this invoice.',
    language: "en",
    tier: 2,
    taskType: "create_payment",
    expectedEntities: [
      {
        customerName: "Solberg Industri AS",
        organizationNumber: "944555666",
        amount: 18000,
      },
    ],
    expectedApiCalls: { max: 3, maxErrors: 0 },
  },

  {
    id: "canonical-create_credit_note",
    prompt:
      'The customer Fjellet Eiendom AS (org no. 955666777) has complained about the invoice for "Vedlikeholdsavtale" (9500 NOK excl. VAT). Issue a full credit note that reverses the entire invoice.',
    language: "en",
    tier: 2,
    taskType: "create_credit_note",
    expectedEntities: [
      {
        customerName: "Fjellet Eiendom AS",
        organizationNumber: "955666777",
        amount: 9500,
        productName: "Vedlikeholdsavtale",
      },
    ],
    expectedApiCalls: { max: 8, maxErrors: 0 },
  },

  {
    id: "canonical-create_travel_expense",
    prompt:
      'Register a travel expense report for Marte Olsen (marte.olsen@example.com) for "Kundebesøk Trondheim". The trip lasted 3 days with per diem (daily rate 800 NOK). Expenses: flight ticket 3200 NOK and taxi 450 NOK.',
    language: "en",
    tier: 2,
    taskType: "create_travel_expense",
    expectedEntities: [
      {
        employeeFirstName: "Marte",
        employeeLastName: "Olsen",
        employeeEmail: "marte.olsen@example.com",
        days: 3,
        perDiemRate: 800,
      },
    ],
    expectedApiCalls: { max: 2, maxErrors: 0 },
  },

  {
    id: "canonical-create_payroll",
    prompt:
      "Run payroll for Lars Berg (lars.berg@example.com) for this month. The base salary is 52000 NOK. Add a one-time bonus of 8000 NOK on top of the base salary.",
    language: "en",
    tier: 2,
    taskType: "create_payroll",
    expectedEntities: [
      {
        employeeFirstName: "Lars",
        employeeLastName: "Berg",
        employeeEmail: "lars.berg@example.com",
        baseSalary: 52000,
        bonus: 8000,
      },
    ],
    expectedApiCalls: { max: 3, maxErrors: 0 },
  },

  {
    id: "canonical-create_supplier_invoice",
    prompt:
      "We have received invoice F-2026-042 from the supplier Renhold Pluss AS (org no. 966777888) for 12500 NOK including VAT. The amount relates to office services (account 6300). Register the supplier invoice with the correct input VAT (25%).",
    language: "en",
    tier: 2,
    taskType: "create_supplier_invoice",
    expectedEntities: [
      {
        supplierName: "Renhold Pluss AS",
        organizationNumber: "966777888",
        amount: 12500,
        accountNumber: 6300,
      },
    ],
    expectedApiCalls: { max: 3, maxErrors: 0 },
  },

  {
    id: "canonical-create_dimension",
    prompt:
      'Create a custom accounting dimension "Region" with the values "Nord-Norge" and "Vestlandet". Then post a voucher on account 6100 for 25000 NOK, linked to the dimension value "Nord-Norge".',
    language: "en",
    tier: 2,
    taskType: "create_dimension",
    expectedEntities: [
      {
        dimensionName: "Region",
        accountNumber: 6100,
        amount: 25000,
        linkedDimensionValue: "Nord-Norge",
      },
    ],
    expectedApiCalls: { max: 4, maxErrors: 0 },
  },

  {
    id: "canonical-reverse_payment",
    prompt:
      'The payment from Kysten Shipping AS (org no. 977888999) for the invoice "Markedsanalyse" (15000 NOK excl. VAT) was returned by the bank. Reverse the payment so the invoice shows the outstanding amount again.',
    language: "en",
    tier: 2,
    taskType: "reverse_payment",
    expectedEntities: [
      {
        customerName: "Kysten Shipping AS",
        organizationNumber: "977888999",
        amount: 15000,
        productName: "Markedsanalyse",
      },
    ],
    expectedApiCalls: { max: 4, maxErrors: 0 },
  },

  {
    id: "canonical-project_fixed_price",
    prompt:
      'Set a fixed price of 200000 NOK on the project "ERP Implementering" for Innlandet Teknologi AS (org no. 988999111). The project manager is Hanne Vik (hanne.vik@example.com). Invoice the customer for 75% of the fixed price as a milestone payment.',
    language: "en",
    tier: 2,
    taskType: "project_fixed_price",
    expectedEntities: [
      {
        projectName: "ERP Implementering",
        customerName: "Innlandet Teknologi AS",
        fixedPrice: 200000,
        invoicePercentage: 75,
      },
    ],
    expectedApiCalls: { max: 9, maxErrors: 0 },
  },

  {
    id: "canonical-create_timesheet",
    prompt:
      'Log 40 hours for Jonas Bakke (jonas.bakke@example.com) on the activity "Backend-utvikling" in the project "App Modernisering" for Teknogruppen AS (org no. 899111222). Hourly rate: 1200 NOK/h. Generate a project invoice to the customer based on the logged hours.',
    language: "en",
    tier: 2,
    taskType: "create_timesheet",
    expectedEntities: [
      {
        employeeFirstName: "Jonas",
        employeeLastName: "Bakke",
        employeeEmail: "jonas.bakke@example.com",
        hours: 40,
        activityName: "Backend-utvikling",
        projectName: "App Modernisering",
        customerName: "Teknogruppen AS",
        hourlyRate: 1200,
      },
    ],
    expectedApiCalls: { max: 4, maxErrors: 0 },
  },

  // ═══════════════════════════════════════════════════════════════════
  // TIER 3 — Complex / file-based (12 types)
  // ═══════════════════════════════════════════════════════════════════

  {
    id: "canonical-receipt_expense",
    prompt:
      "We need the office supplies expense from this receipt booked to department Administrasjon. Use the correct expense account based on the purchase, and ensure correct VAT treatment.",
    language: "en",
    tier: 3,
    taskType: "receipt_expense",
    expectedEntities: [
      {
        itemDescription: "office supplies",
        departmentName: "Administrasjon",
      },
    ],
    expectedApiCalls: { max: 6, maxErrors: 0 },
    requiresFile: true,
    fileType: "pdf",
  },

  {
    id: "canonical-employee_onboarding_pdf",
    prompt:
      "You received an offer letter (see attached PDF) for a new employee. Complete the onboarding: create the employee, assign the correct department, set up employment details with percentage and annual salary, and configure standard working hours.",
    language: "en",
    tier: 3,
    taskType: "employee_onboarding_pdf",
    expectedEntities: [],
    expectedApiCalls: { max: 8, maxErrors: 0 },
    requiresFile: true,
    fileType: "pdf",
  },

  {
    id: "canonical-employee_contract_pdf",
    prompt:
      "You received an employment contract (see attached PDF). Create the employee in Tripletex with all the contract details: identity number, date of birth, department, occupation code, salary, employment percentage, and start date.",
    language: "en",
    tier: 3,
    taskType: "employee_contract_pdf",
    expectedEntities: [],
    expectedApiCalls: { max: 8, maxErrors: 0 },
    requiresFile: true,
    fileType: "pdf",
  },

  {
    id: "canonical-supplier_invoice_pdf",
    prompt:
      "You received a supplier invoice (see attached PDF). Register the invoice in Tripletex. Create the supplier if it does not exist. Use the correct expense account and input VAT.",
    language: "en",
    tier: 3,
    taskType: "supplier_invoice_pdf",
    expectedEntities: [],
    expectedApiCalls: { max: 6, maxErrors: 0 },
    requiresFile: true,
    fileType: "pdf",
  },

  {
    id: "canonical-bank_reconciliation",
    prompt:
      "Reconcile the bank statement (attached CSV) against open invoices in Tripletex. Match incoming payments to customer invoices and outgoing payments to supplier invoices. Handle partial payments correctly.",
    language: "en",
    tier: 3,
    taskType: "bank_reconciliation",
    expectedEntities: [],
    expectedApiCalls: { max: 15, maxErrors: 0 },
    requiresFile: true,
    fileType: "csv",
  },

  {
    id: "canonical-ledger_audit",
    prompt:
      "We have discovered errors in the general ledger for January and February 2026. Review all vouchers and find the 4 errors: a posting on the wrong account, a duplicate voucher, a missing VAT line, and an incorrect amount. Correct all errors with corrective entries.",
    language: "en",
    tier: 3,
    taskType: "ledger_audit",
    expectedEntities: [],
    expectedApiCalls: { max: 4, maxErrors: 0 },
  },

  {
    id: "canonical-ledger_analysis",
    prompt:
      "Total costs have risen significantly from January to February 2026. Analyze the general ledger and identify the three expense accounts with the largest increase. Create an internal project for each of the three accounts. Also create an activity for each project.",
    language: "en",
    tier: 3,
    taskType: "ledger_analysis",
    expectedEntities: [],
    expectedApiCalls: { max: 5, maxErrors: 0 },
  },

  {
    id: "canonical-year_end_closing",
    prompt:
      "Perform the simplified year-end closing for 2025: 1) Calculate and post annual depreciation for three assets: Office equipment (account 1200, original value 120000 NOK, 20% depreciation rate, depreciation to account 6010), Vehicles (account 1230, original value 350000 NOK, 15% depreciation rate, depreciation to account 6020), and Software licenses (account 1210, original value 80000 NOK, 33% depreciation rate, depreciation to account 6030). 2) Reverse the prepaid rent of 60000 NOK from account 1710 to expense account 6300. 3) Calculate and post the tax provision (22% of taxable income).",
    language: "en",
    tier: 3,
    taskType: "year_end_closing",
    expectedEntities: [
      {
        fiscalYear: 2025,
        taxRate: 22,
      },
    ],
    expectedApiCalls: { max: 2, maxErrors: 0 },
  },

  {
    id: "canonical-monthly_closing",
    prompt:
      "Perform the monthly closing for March 2026. Record the accrual reversal (15000 NOK per month from account 1710 to expense account 6300). Record monthly depreciation of 5000 NOK (debit account 6010, credit account 1209). Verify trial balance is zero. Record a salary provision of 180000 NOK (debit account 5000, credit account 2900).",
    language: "en",
    tier: 3,
    taskType: "monthly_closing",
    expectedEntities: [],
    expectedApiCalls: { max: 2, maxErrors: 0 },
    notes: "Accrual: 15000 (1710→6300). Depreciation: 5000 (6010/1209). Salary provision: 180000 (5000/2900).",
  },

  {
    id: "canonical-fx_payment",
    prompt:
      "We sent an invoice for 10000 EUR to Eurotech GmbH (org no. 811333555) when the exchange rate was 11.50 NOK/EUR. The customer has now paid, but the rate is 11.20 NOK/EUR. Register the payment and post the exchange difference (disagio/agio) to the correct account.",
    language: "en",
    tier: 3,
    taskType: "fx_payment",
    expectedEntities: [
      {
        customerName: "Eurotech GmbH",
        organizationNumber: "811333555",
        invoiceAmountForeign: 10000,
        currency: "EUR",
        invoiceRate: 11.5,
        paymentRate: 11.2,
      },
    ],
    expectedApiCalls: { max: 3, maxErrors: 0 },
  },

  {
    id: "canonical-project_lifecycle",
    prompt:
      'Execute the complete project lifecycle for "Digital Transformasjon" (Skynet Consulting AS, org no. 822444666): 1) Budget of 500000 NOK. 2) Register 80 hours for Ingrid Moe at 1100 NOK/h and 60 hours for Per Strand at 950 NOK/h. 3) Register supplier cost from IT Leveranse AS of 45000 NOK for server hosting. 4) Create an invoice to the customer for the project.',
    language: "en",
    tier: 3,
    taskType: "project_lifecycle",
    expectedEntities: [
      {
        projectName: "Digital Transformasjon",
        customerName: "Skynet Consulting AS",
        organizationNumber: "822444666",
        budgetAmount: 500000,
      },
    ],
    expectedApiCalls: { max: 12, maxErrors: 0 },
  },

  {
    id: "canonical-reminder_fee",
    prompt:
      "One of your customers has an overdue invoice. Find the overdue invoice and register a reminder fee of 50 NOK. Debit accounts receivable (1500), credit reminder income (3400). Also create an invoice for the reminder fee to the customer and send it. Additionally, register a partial payment of 5000 NOK on the overdue invoice.",
    language: "en",
    tier: 3,
    taskType: "reminder_fee",
    expectedEntities: [
      {
        reminderFeeAmount: 50,
        partialPaymentAmount: 5000,
        debitAccount: 1500,
        creditAccount: 3400,
      },
    ],
    expectedApiCalls: { max: 10, maxErrors: 0 },
  },
];
