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

### BETA Endpoint Warning
Many endpoints marked [BETA] in the Tripletex API return 403 Forbidden in the competition sandbox.
- Safe batch /list endpoints: /department/list, /product/list, /employee/list, /supplier/list, /ledger/account/list
- BETA batch endpoints (403): /customer/list, /invoice/list, /order/list, /project/list — use single POST instead
- If any call returns 403, assume the endpoint is BETA and switch to an alternative. Do NOT retry.

### Employee
- GET /employee — list/search. Params: firstName, lastName, email, fields, from, count
- POST /employee — create. Body: { firstName, lastName, department: {id}, email?, dateOfBirth?, phoneNumberMobile?, employeeNumber?, userType? }
  - department: {id} is REQUIRED. Look up via GET /department first.
  - userType: "NO_ACCESS" | "STANDARD" | "EXTENDED". Use "EXTENDED" for users who need admin or PM roles.
  - Note: "ADMINISTRATOR" is NOT a valid userType — admin is granted via entitlements.
- PUT /employee/{id} — update (include id, version, and changed fields)
- POST /employee/employment — create employment. Body: { employee: {id}, startDate, employmentType, percentageOfFullTimeEquivalent, division?: {id} }
  - employmentType: "ORDINARY" | "MARITIME" | "FREELANCE"

### Customer
- GET /customer — list/search. Params: name, email, organizationNumber, from, count
- POST /customer — create. Body: { name, email?, organizationNumber?, phoneNumber?, isCustomer: true, postalAddress?: { addressLine1, postalCode, city } }
  - IMPORTANT: postalAddress MUST be an object like {"addressLine1": "Testgate 1", "postalCode": "0001", "city": "Oslo"}, NEVER a string. Passing a string causes 422.
- PUT /customer/{id} — update
- ~~DELETE /customer/{id}~~ — [BETA, returns 403] customers cannot be deleted
- ~~POST /customer/list~~ — [BETA, returns 403] use repeated POST /customer instead

### Supplier
- GET /supplier — list/search. Params: name, email, organizationNumber, from, count
- POST /supplier — create. Body: { name, email?, organizationNumber?, phoneNumber?, isSupplier: true }
- PUT /supplier/{id} — update

### Product
- GET /product — list/search. Params: name, number, from, count
- POST /product — create. Body: { name, number?, priceExcludingVatCurrency?, department: {id}, productUnit?: {id}, vatType: {id} }
  - vatType MUST be {id: <number>} where id comes from GET /ledger/vatType. It is NOT the percentage.
  - Common VAT type IDs (look up to confirm): 25% standard output VAT, 15% food/beverage, 0% exempt.
  - ALWAYS call GET /ledger/vatType?from=0&count=100 first to find the correct id.
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
- ~~POST /invoice/list~~ — [BETA, returns 403] use repeated POST /invoice instead

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
- ~~POST /order/list~~ — [BETA, returns 403] use repeated POST /order instead

### Order Line
- POST /order/orderline — create a single order line. Body: { order: {id}, product?: {id}, description, count, unitPriceExcludingVatCurrency }

### Project
- GET /project — list. Params: name, from, count
- POST /project — create (non-beta). Body: { name, startDate, endDate?, projectManager: {id}, department: {id}, isInternal: true/false, customer?: {id}, description?, projectCategory?: {id} }
- ~~POST /project/list~~ — [BETA, returns 403] use repeated POST /project instead
- ~~PUT /project/{id}~~ — [BETA, returns 403] projects cannot be updated via API
- ~~DELETE /project/{id}~~ — [BETA, returns 403] projects cannot be deleted

### Travel Expense
- GET /travelExpense — list. Params: employeeId, from, count
- POST /travelExpense — create. Body: { employee: {id}, title, date (YYYY-MM-DD) }
  - IMPORTANT: The field is "title", NOT "comment". There is NO "comment" field on travelExpense — it causes 422.
  - Do NOT include "costs" inline — add them separately via POST /travelExpense/cost after creation.
- DELETE /travelExpense/{id} — delete
- PUT /travelExpense/:deliver — deliver for approval
- POST /travelExpense/cost — add a cost line. Body: { travelExpense: {id}, paymentType: {id}, date (YYYY-MM-DD), amountCurrencyIncVat, comments? }
  - IMPORTANT: The text field is "comments", NOT "description". Using "description" causes 422.
  - Get paymentType IDs from: GET /travelExpense/paymentType

### Voucher (Ledger)
- GET /ledger/voucher — list. Params: dateFrom, dateTo, from, count
- POST /ledger/voucher — create.
  EXACT body format:
  { "date": "YYYY-MM-DD", "description": "text", "postings": [
    {"row": 1, "account": {"id": <ID>}, "date": "YYYY-MM-DD", "amountGross": 1000, "amountGrossCurrency": 1000, "description": "Debit line"},
    {"row": 2, "account": {"id": <ID>}, "date": "YYYY-MM-DD", "amountGross": -1000, "amountGrossCurrency": -1000, "description": "Credit line"}
  ]}
  RULES:
  - row MUST start at 1, then 2, 3, etc. NEVER use row 0 (system-reserved, causes 422).
  - Standard fields per posting: row, account, date, amountGross, amountGrossCurrency, description.
  - NEVER add guiRow, dimension fields, supplierId, or any dimension fields.
  - EXCEPTION: Postings to account 2400 (accounts payable) MUST include "supplier": {"id": <supplierId>}. Omitting it causes 422.
  - amountGross = amountGrossCurrency (always identical). Positive = debit, negative = credit.
  - All amountGross values MUST sum to 0.
  - Get account IDs via GET /ledger/account?number=XXXX, then use the returned "id" field.
- DELETE /ledger/voucher/{id} — delete/reverse a voucher

### Ledger Account
- GET /ledger/account — list/search. Params: number, from, count, fields
  - Use ?number=<accountNumber> to find by account number (e.g. 1920, 3000, 4000)

### Accounting Dimensions (Custom/Free Dimensions)
- GET /ledger/accountingDimensionName — list ALL existing dimensions. ALWAYS call this first to check if dimension exists.
- POST /ledger/accountingDimensionName — create. Body: { dimensionName, active: true }
  - ONLY create if GET shows the dimension doesn't exist. "Navnet er i bruk" = name already taken.
  - Max 3 dimensions (indices 1, 2, 3). Returns the dimensionIndex.
- GET /ledger/accountingDimensionValue?dimensionIndex=X — list values for a dimension. ALWAYS call to check before creating.
- POST /ledger/accountingDimensionValue — create. Body: { dimensionIndex, displayName, active: true, showInVoucherRegistration: true }
  - ONLY create if GET shows the value doesn't exist for this dimension.
- IMPORTANT: Voucher postings do NOT reference dimensions. Create dimensions/values separately, then create the voucher with standard balanced postings.

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

### Incoming Invoice [BETA — returns 403]
- ~~POST /incomingInvoice~~ — [BETA] not available in sandbox
- ~~POST /incomingInvoice/{voucherId}/addPayment~~ — [BETA] not available
- Alternative: Create a voucher with balanced postings. The credit posting to account 2400 MUST include supplier: {id: supplierId}.

### Supplier Invoice
- GET /supplierInvoice — list
- PUT /supplierInvoice/:approve — approve

### Company Settings
- PUT /company — update company info
- ~~POST /company/salesmodules~~ — [BETA, returns 403] modules cannot be activated via API

### Employee Entitlements [BETA — may return 403]
- GET /employee/entitlement — list role entitlements. Params: employeeId, from, count  
- POST /employee/entitlement — grant entitlement. Body: { employee: {id}, entitlementId: <number>, customer: {id: <companyId>} }
  - Key entitlementIds: 1 = ROLE_ADMINISTRATOR, 10 = AUTH_PROJECT_MANAGER, 45 = AUTH_CREATE_PROJECT
  - IMPORTANT: employee must have userType "EXTENDED" to receive entitlements. AUTH_PROJECT_MANAGER requires AUTH_CREATE_PROJECT (45) first.
  - WARNING: These endpoints are [BETA]. If they return 403, the entitlement cannot be granted via API. The first employee in the sandbox usually already has project manager rights.

### Salary [BETA — returns 403]
- ~~POST /salary/transaction~~ — [BETA] returns 403 in sandbox. Do NOT use.
- ~~GET /salary/payslip~~ — [BETA] returns 403 in sandbox. Do NOT use.
- For payroll tasks, ALWAYS use POST /ledger/voucher with salary accounts (see PAYROLL recipe in system prompt).

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
