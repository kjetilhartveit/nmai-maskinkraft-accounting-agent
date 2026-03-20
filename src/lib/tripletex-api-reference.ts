/**
 * Condensed Tripletex API reference for the generic agentic handler.
 * Covers the most important endpoints, their methods, required fields,
 * and common patterns for Norwegian accounting operations.
 */
export const TRIPLETEX_API_REFERENCE = `
## Tripletex API v2 Reference (Condensed)

### General Patterns
- All list endpoints: GET returns { fullResultSize, values: [...] }
- Use ?fields=id,name,* to select fields. Use * for all writable fields.
- Use ?from=0&count=100 for pagination.
- POST returns { value: {...} } for single creates.
- Basic Auth: username "0", password = session_token.
- All dates must be YYYY-MM-DD format.
- When linking to existing resources, use { id: <number> } format.

### Employee
- GET /employee — list/search. Params: firstName, lastName, email, fields, from, count
- POST /employee — create. Body: { firstName, lastName, email, dateOfBirth?, phoneNumberMobile?, employeeNumber?, userType? }
  - userType: "STANDARD" (default), "ADMINISTRATOR" (full admin)
- PUT /employee/{id} — update (include id, version, and changed fields)
- POST /employee/employment — create employment. Body: { employee: {id}, startDate, employmentType, percentageOfFullTimeEquivalent, division?: {id} }
  - employmentType: "ORDINARY" | "MARITIME" | "FREELANCE"

### Customer
- GET /customer — list/search. Params: name, email, organizationNumber, from, count
- POST /customer — create. Body: { name, email?, organizationNumber?, phoneNumber?, isCustomer: true, postalAddress?: { addressLine1, postalCode, city } }
- PUT /customer/{id} — update
- DELETE /customer/{id} — delete

### Supplier
- GET /supplier — list/search. Params: name, email, organizationNumber, from, count
- POST /supplier — create. Body: { name, email?, organizationNumber?, phoneNumber?, isSupplier: true }
- PUT /supplier/{id} — update

### Product
- GET /product — list/search. Params: name, number, from, count
- POST /product — create. Body: { name, priceExcludingVatCurrency?, department: {id}, productUnit?: {id}, vatType?: {id} }
- GET /product/unit — list product units (stk, kg, etc.)

### Department
- GET /department — list/search. Params: name, from, count
- POST /department — create. Body: { name, departmentNumber? }
- PUT /department/{id} — update
- DELETE /department/{id} — delete

### Division
- GET /division — list. Params: from, count
- POST /division — create. Body: { name, startDate, organizationNumber? }

### Contact
- GET /contact — list. Params: firstName, lastName, email, from, count
- POST /contact — create. Body: { firstName, lastName, email?, phoneNumberMobile?, customer?: {id}, department?: {id} }

### Invoice
- GET /invoice — list. REQUIRED params: invoiceDateFrom (YYYY-MM-DD), invoiceDateTo (YYYY-MM-DD). Optional: customerId, from, count
  - IMPORTANT: Both invoiceDateFrom and invoiceDateTo are REQUIRED. Use wide date range like 2020-01-01 to 2026-12-31.
- GET /invoice/{id} — get single invoice by ID. Returns { value: {...} }
- POST /invoice — create. Body: { invoiceDate, invoiceDueDate, customer: {id}, orders: [{id}], comment? }
  - Typically requires an Order first. Or include orderLines inline.
  - IMPORTANT: Bank account must be configured on ledger account 1920 before creating invoices.
- POST /invoice/{id}/:send — send an invoice via email/EHF
  - Params: sendType (EMAIL), overrideEmailAddress?

### Invoice Payment (IMPORTANT — use PUT with query params, NOT body)
- PUT /invoice/{id}/:payment — register payment on invoice. Uses QUERY PARAMETERS:
  - paymentDate (YYYY-MM-DD) — required
  - paymentTypeId (number) — required (get from GET /invoice/paymentType)
  - paidAmount (number) — required (amount in invoice currency)
  - paidAmountCurrency (number) — optional
  - Use the tripletex_put_action tool for this endpoint!
  - Example: PUT /invoice/123/:payment?paymentDate=2026-03-20&paymentTypeId=456&paidAmount=10000

### Order
- GET /order — list. REQUIRED params: orderDateFrom (YYYY-MM-DD), orderDateTo (YYYY-MM-DD). Optional: from, count
- POST /order — create. Body: { customer: {id}, orderDate, deliveryDate (REQUIRED), orderLines: [{ product?: {id}, description, count, unitPriceExcludingVatCurrency }] }
  - IMPORTANT: deliveryDate is REQUIRED.
  - orderLines can reference existing products or use inline descriptions.

### Order Line
- POST /order/orderline — create a single order line. Body: { order: {id}, product?: {id}, description, count, unitPriceExcludingVatCurrency }

### Project
- GET /project — list. Params: name, from, count
- POST /project — create. Body: { name, startDate, endDate?, projectManager: {id}, department: {id}, isInternal: true/false, customer?: {id}, description?, projectCategory?: {id} }

### Travel Expense
- GET /travelExpense — list. Params: employeeId, from, count
- POST /travelExpense — create. Body: { employee: {id}, title, department?: {id}, project?: {id}, costs: [{ date, description, amountCurrencyIncVat, paymentType: "company_card"|"employee_paid", vatType?: {id}, currency?: {id}, category?: {id} }] }
  - costs.paymentType must be one of the valid payment types
- DELETE /travelExpense/{id} — delete
- PUT /travelExpense/:deliver — deliver for approval
- POST /travelExpense/cost — add a cost line. Body: { travelExpense: {id}, date, description, amountCurrencyIncVat, paymentType, currency: {id} }

### Voucher (Ledger)
- GET /ledger/voucher — list. Params: dateFrom, dateTo, from, count
- POST /ledger/voucher — create. Body: { date (YYYY-MM-DD), description, postings: [{ account: {id}, date (YYYY-MM-DD), amountGross, description? }] }
  - IMPORTANT: Only gross amounts are used. Positive = debit, negative = credit.
  - Postings MUST balance (sum to zero).
- DELETE /ledger/voucher/{id} — delete/reverse a voucher
- POST /ledger/voucher/{voucherId}/attachment — upload attachment (multipart)

### Ledger Account
- GET /ledger/account — list/search. Params: number, from, count, fields
  - Use ?number=<accountNumber> to find by account number (e.g. 1920, 3000, 4000)

### Accounting Dimensions (Custom/Free Dimensions)
- GET /ledger/accountingDimensionName — list dimension definitions
- POST /ledger/accountingDimensionName — create. Body: { dimensionName, description?, active: true }
  - Creates a free dimension (max 3: indices 1, 2, 3)
- GET /ledger/accountingDimensionValue — list dimension values. Params: dimensionIndex, from, count
- POST /ledger/accountingDimensionValue — create. Body: { dimensionIndex, displayName, number?, active: true, showInVoucherRegistration: true }

### VAT Types
- GET /ledger/vatType — list all VAT types. Params: from, count
  - Common: code "3" = utgående mva høy sats 25%

### Currency
- GET /currency — list. Params: code (e.g. "NOK", "EUR"), from, count

### Payment Type
- GET /invoice/paymentType — list payment types for invoices

### Bank Reconciliation
- POST /bank/reconciliation — create. Body: { account: {id}, accountingPeriod: {id}, type, bankAccountClosingBalanceCurrency }
- POST /bank/reconciliation/match — match transactions. Body: { bankReconciliation: {id}, transactions: [{id}] }
- POST /bank/statement/import — upload bank statement (multipart)

### Incoming Invoice
- POST /incomingInvoice — create. Body: { invoiceDate, invoiceDueDate, supplier: {id}, voucher: {id} }
- POST /incomingInvoice/{voucherId}/addPayment — register payment

### Supplier Invoice
- GET /supplierInvoice — list
- PUT /supplierInvoice/:approve — approve

### Company Settings
- PUT /company — update company info
- POST /company/salesmodules — activate modules. Body: { name }
  - Module names: e.g. "ACCOUNTING", "INVOICE", "PROJECT"

### Employee Entitlements
- GET /employee/entitlement — list role entitlements. Params: employeeId, from, count  
- POST /employee/entitlement — grant entitlement. Body: { employee: {id}, entitlement: "<entitlement_name>" }
  - Key entitlements: "ADMINISTRATOR", "PROJECT_MANAGER"

### Salary
- POST /salary/transaction — create salary voucher. Body: { date, year, month, payslips: [...] }

### Timesheet
- POST /timesheet/entry — create timesheet entry. Body: { employee: {id}, project: {id}, activity: {id}, date, hours, comment? }
- GET /timesheet/entry — list. Params: employeeId, dateFrom, dateTo

### Asset
- POST /asset — create. Body: { name, dateOfAcquisition, acquisitionCost, account: {id}, depreciationAccount: {id}, lifetime, depreciationMethod }

### Common Patterns
1. The sandbox MAY have pre-existing data (e.g. a customer with an invoice for payment tasks). ALWAYS search first.
2. When searching: use wide date ranges (2020-01-01 to 2026-12-31) for date-required endpoints.
3. Invoices require: customer → product → order → invoice (or inline order lines).
4. Bank account (1920) must have a bankAccountNumber configured before invoice creation.
5. Projects require: department → employee (as project manager) → project.
6. Voucher postings must balance (debits + credits = 0).
7. Custom dimensions: create dimensionName first, then dimensionValues with the returned dimensionIndex.
8. Action endpoints (/:payment, /:send, /:deliver, /:approve) use QUERY PARAMETERS, not body.
9. For payment tasks: find existing invoice → get payment types → PUT /invoice/{id}/:payment with query params.
`;
