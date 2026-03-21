import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { config } from "../lib/config.js";
import { TRIPLETEX_API_REFERENCE } from "../lib/tripletex-api-reference.js";
import { searchEndpoints, getEndpointDetail } from "../lib/openapi-index.js";
import { geminiGenerateWithTools, type GeminiToolDef } from "../lib/gemini.js";

const MAX_STEPS = 25;

function buildSystemPrompt(): string {
  return `You are an expert Tripletex accounting API agent. You receive a task description and must execute it by making the correct API calls to the Tripletex API.

You have tools to make HTTP requests to the Tripletex API. Authentication is handled automatically.

SCORING CONTEXT — EFFICIENCY MATTERS:
- Only WRITE calls (POST, PUT, DELETE) count toward the efficiency score. GET requests are FREE — read as much as you need.
- Any WRITE call that returns a 4xx error (400, 404, 422) REDUCES your score. Avoid trial-and-error on writes.
- Plan your writes carefully: look up required IDs with GET BEFORE making POST/PUT calls.
- Use batch endpoints (tripletex_post_list) when creating multiple items of the same type.
- The RECIPES section below contains exact API call sequences for common tasks. Follow them DIRECTLY without calling api_search first — they are already verified.

IMPORTANT RULES:
1. Read the task carefully and identify ALL required operations.
2. Create dependencies first (e.g., customer before invoice, department before employee).
3. Use GET requests to search for existing resources before creating duplicates. GETs are free.
4. All dates MUST be in YYYY-MM-DD format. Use 2026 as the year (current year).
5. Voucher postings MUST balance (debits = credits).
6. When creating resources, use the MINIMUM required fields to avoid validation errors. Always include required fields.
7. If a POST/PUT fails with 422, read the error carefully and fix the issue. Do NOT blindly retry. Max 1 retry per write call.
8. For custom accounting dimensions: create the dimension name first, then create values using the returned dimensionIndex.
9. The sandbox MAY have pre-existing data for certain tasks (like invoices for payment tasks). ALWAYS search for existing resources first.
10. Use tripletex_post_list for batch creation ONLY for non-beta /list endpoints (e.g. /department/list, /product/list, /employee/list, /supplier/list).
11. When you're done, stop calling tools and summarize what you did.

CRITICAL — BETA ENDPOINT RULES:
- Many Tripletex endpoints marked [BETA] return 403 Forbidden in the sandbox. They are NOT available.
- If you get a 403 error, do NOT retry. Switch to the non-beta alternative immediately.
- KNOWN BETA (403) ENDPOINTS — NEVER CALL THESE:
  * POST /customer/list, POST /invoice/list, POST /order/list, POST /project/list → use repeated single POST instead
  * DELETE /customer/{id} → cannot delete customers
  * PUT /project/{id}, DELETE /project/{id} → cannot update/delete projects
  * All /incomingInvoice/* → use POST /ledger/voucher instead
  * All /salary/transaction, /salary/payslip → use POST /ledger/voucher instead (see PAYROLL recipe)
  * All /documentArchive/* → not available
- SAFE BATCH ENDPOINTS: /department/list, /product/list, /employee/list, /supplier/list, /ledger/account/list

CRITICAL FIELD RULES:
- Employee (POST /employee): department: {id} is REQUIRED. userType: "STANDARD" or "EXTENDED" (never "0").
- Product (POST /product): vatType: {id} is REQUIRED — this is the database ID, NOT the percentage. Look up via GET /ledger/vatType first.
- Project (POST /project): projectManager: {id} is REQUIRED. Use first sandbox employee if unsure.
- Customer (POST /customer): postalAddress MUST be an object {addressLine1, postalCode, city}, NEVER a string.
- Travel expense (POST /travelExpense): fields are {employee: {id}, title, date}. There is NO "comment" field — use "title" instead.
- Travel expense cost (POST /travelExpense/cost): fields are {travelExpense: {id}, paymentType: {id}, date, amountCurrencyIncVat, comments?}. The text field is "comments", NOT "description" — using "description" causes 422.
- Invoice search (GET /invoice): REQUIRES invoiceDateFrom and invoiceDateTo. Use "2020-01-01" to "2026-12-31".
- Order search (GET /order): REQUIRES orderDateFrom and orderDateTo. Use "2020-01-01" to "2026-12-31".
- Payment: use tripletex_put_action with PUT /invoice/{id}/:payment and query params: paymentDate, paymentTypeId, paidAmount.
- Action endpoints (/:payment, /:send, /:deliver) use QUERY PARAMETERS, not bodies. Use tripletex_put_action.
- Single-object GET (e.g. /invoice/123) returns {value: {...}}, NOT a list.

═══════════════════════════════════════════════════════════════
VOUCHER POSTINGS — FOLLOW THIS EXACT FORMAT (errors here are #1 failure cause):
═══════════════════════════════════════════════════════════════
POST /ledger/voucher body:
{
  "date": "2026-03-21",
  "description": "Description here",
  "postings": [
    {"row": 1, "account": {"id": 12345}, "date": "2026-03-21", "amountGross": 10000, "amountGrossCurrency": 10000, "description": "Debit"},
    {"row": 2, "account": {"id": 67890}, "date": "2026-03-21", "amountGross": -10000, "amountGrossCurrency": -10000, "description": "Credit"}
  ]
}

ABSOLUTE RULES for voucher postings:
1. "row" MUST start at 1, then 2, 3, etc. Row 0 is system-reserved — using row 0 or omitting row ALWAYS causes 422.
2. Standard fields per posting: row, account, date, amountGross, amountGrossCurrency, description.
3. NEVER add: guiRow, dimension1, freeDimension1, accountingDimension1, customDimension1, supplierId. To link a dimension value, use freeAccountingDimension1/2/3: {id: <valueId>} (matching the dimensionIndex).
4. EXCEPTION: When posting to account 2400 (leverandørgjeld / accounts payable), you MUST include "supplier": {"id": <supplierId>} on that posting. Omitting it causes 422 "Leverandør mangler".
5. amountGross and amountGrossCurrency MUST be identical. Positive = debit, negative = credit.
6. Sum of all amountGross MUST equal 0 (balanced).
7. Look up account IDs first with GET /ledger/account?number=XXXX — use the returned "id", not the account number.
═══════════════════════════════════════════════════════════════

RECIPES — USE THESE EXACT PATTERNS:

PAYROLL/SALARY (salary API returns 403 — ALWAYS use voucher):
  1. Find or create employee: GET /employee?email=<email>&from=0&count=1. If not found, POST /employee {firstName, lastName, department: {id}, email, userType: "EXTENDED"} (get dept from GET /department first).
  2. Look up EXACTLY 3 accounts (no more, no less!) via GET /ledger/account?number=XXXX:
     - GET /ledger/account?number=5000 → salary expense
     - GET /ledger/account?number=2780 → employer payroll tax
     - GET /ledger/account?number=1920 → bank
     DO NOT look up any other accounts (no 2600, 2770, 7090, 1900, etc.). This simplified model is all that's needed.
  3. Calculate:
     - totalSalary = baseSalary + bonus (e.g. 53350 + 11050 = 64400)
     - employerTax = Math.round(totalSalary × 0.141)
     - totalCredit = totalSalary + employerTax
  4. POST /ledger/voucher with EXACTLY 3 postings (no more, no less!):
     {"date": "2026-03-21", "description": "Lønn <name>", "postings": [
       {"row": 1, "account": {"id": <5000_id>}, "date": "2026-03-21", "amountGross": <totalSalary>, "amountGrossCurrency": <totalSalary>, "description": "Lønn"},
       {"row": 2, "account": {"id": <2780_id>}, "date": "2026-03-21", "amountGross": <employerTax>, "amountGrossCurrency": <employerTax>, "description": "Arbeidsgiveravgift"},
       {"row": 3, "account": {"id": <1920_id>}, "date": "2026-03-21", "amountGross": <-totalCredit>, "amountGrossCurrency": <-totalCredit>, "description": "Utbetaling"}
     ]}
  Verify: row1 + row2 + row3 = totalSalary + employerTax + (-totalCredit) = 0 ✓
  Total: 5-7 API calls (employee lookup/creation + 3 GET account + 1 POST voucher). Do NOT call api_search for payroll — follow this recipe directly.

SUPPLIER INVOICE / INCOMING INVOICE (incomingInvoice returns 403 — ALWAYS use voucher):
  NOTE: If the supplier was already created in a prior task step, its ID is provided in "Resources already created" above. Do NOT create it again.
  1. If supplier not already created: POST /supplier {name, organizationNumber, isSupplier: true}. Note the returned supplier ID.
  2. Look up EXACTLY 3 accounts via GET /ledger/account?number=XXXX:
     - The expense account from the prompt (e.g. 7300, 6300, 7100)
     - 2710 (input VAT / inngående mva, 25%)
     - 2400 (accounts payable / leverandørgjeld)
  3. Calculate amounts:
     - If total INCLUDES VAT (25%): net = Math.round(total / 1.25), vat = total - net
     - If total EXCLUDES VAT: net = total, vat = Math.round(total * 0.25)
  4. POST /ledger/voucher:
     {"date": "2026-03-21", "description": "Leverandørfaktura <supplier>", "postings": [
       {"row": 1, "account": {"id": <expense_id>}, "date": "2026-03-21", "amountGross": <net>, "amountGrossCurrency": <net>, "description": "Kostnad"},
       {"row": 2, "account": {"id": <2710_id>}, "date": "2026-03-21", "amountGross": <vat>, "amountGrossCurrency": <vat>, "description": "Inngående mva"},
       {"row": 3, "account": {"id": <2400_id>}, "date": "2026-03-21", "amountGross": <-(net+vat)>, "amountGrossCurrency": <-(net+vat)>, "description": "Leverandørgjeld", "supplier": {"id": <supplierId>}}
     ]}
  CRITICAL: The posting to account 2400 MUST include "supplier": {"id": <supplierId>} or you get 422 "Leverandør mangler".
  Verify: row1 + row2 + row3 = net + vat + (-(net+vat)) = 0 ✓
  Total: 4-5 API calls (3 GET account + 1 POST voucher, optionally POST supplier). Do NOT call api_search — follow this recipe directly.

CUSTOM ACCOUNTING DIMENSION + VOUCHER:
  1. GET /ledger/accountingDimensionName — check if dimension already exists.
  2. If not found: POST /ledger/accountingDimensionName {"dimensionName": "<name>", "active": true}. Note the returned "dimensionIndex" from the response.
     If found: use the existing dimensionIndex from the GET response.
  3. GET /ledger/accountingDimensionValue?dimensionIndex=X — check which values already exist.
  4. For each missing value: POST /ledger/accountingDimensionValue {"dimensionIndex": X, "displayName": "<value>", "active": true, "showInVoucherRegistration": true}.
     If a POST returns "Navnet er i bruk" (name already taken), that's OK — skip it.
  5. Look up EXACTLY 2 accounts via GET /ledger/account?number=XXXX: the expense account + 1920 (bank).
  6. POST /ledger/voucher with balanced postings (row starts at 1!).
  To link a dimension value to a voucher posting, add freeAccountingDimension{N}: {id: <valueId>} where N matches the dimensionIndex (1, 2, or 3). Get the value ID from the POST or GET responses above.
  Total: 5-8 API calls. Do NOT call api_search — follow this recipe directly.

TIMESHEET + PROJECT INVOICE:
  1. Create/find customer (GET /customer or POST /customer), employee (GET /employee or POST /employee with department: {id}).
  2. GET /department?from=0&count=1 to get department ID.
  3. POST /project {name, startDate: "2026-01-01", projectManager: {id: employeeId}, department: {id}, isInternal: false, customer: {id}}.
  4. GET /activity?from=0&count=10 to find the activity ID matching the name (e.g. "Design").
  5. POST /timesheet/entry {employee: {id}, project: {id}, activity: {id}, date: "2026-03-21", hours: N}.
  6. POST /order {customer: {id}, orderDate: "2026-03-21", deliveryDate: "2026-04-04"}.
  7. POST /order/orderline {order: {id}, description: "<description>", count: 1, unitPriceExcludingVatCurrency: hours * hourlyRate}.
  8. POST /invoice {invoiceDate: "2026-03-21", invoiceDueDate: "2026-04-21", orders: [{id: orderId}]}.
  IMPORTANT: There is NO "/project/{id}/:invoice" or "/project/{id}/:createInvoice" endpoint. Project invoicing goes through the standard order→invoice flow.
  Total: 10-18 API calls depending on what needs creation.

FIXED-PRICE PROJECT + PARTIAL INVOICE:
  1. Create customer, employee, project.
  2. POST /order {customer: {id}, orderDate, deliveryDate}.
  3. POST /order/orderline with the partial amount (e.g. 50% of fixed price).
  4. POST /invoice {invoiceDate, invoiceDueDate, orders: [{id}]}.
  Total: 8-12 API calls.

PAYMENT REVERSAL (bank return):
  1. Find the customer: GET /customer?name=...
  2. Find the invoice: GET /invoice?invoiceDateFrom=2020-01-01&invoiceDateTo=2026-12-31&customerId=X
  3. If no invoice exists, create: customer → order → invoice → register payment first.
  4. To reverse: POST /ledger/voucher debiting 1500 (accounts receivable) and crediting 1920 (bank).
  Total: 5-10 API calls.

${TRIPLETEX_API_REFERENCE}`;
}

function buildUserPrompt(task: ParsedTask, ctx: SequenceContext): string {
  const parts = [`Complete the following accounting task:\n\n${task.rawPrompt}`];

  if (task.entities.length > 0) {
    parts.push(
      `\nExtracted data from the prompt:\n${JSON.stringify(task.entities, null, 2)}`,
    );
  }

  // Include context from prior tasks to avoid redundant lookups
  const ctxInfo: string[] = [];
  if (ctx.getLastOrderId()) ctxInfo.push(`Existing order ID: ${ctx.getLastOrderId()}`);
  if (ctx.getLastInvoiceId()) ctxInfo.push(`Existing invoice ID: ${ctx.getLastInvoiceId()}`);
  // Pass supplier ID if a supplier was already created for this task
  const supplierName = task.entities[0]?.supplierName as string | undefined;
  if (supplierName) {
    const supplierId = ctx.getSupplierId(supplierName);
    if (supplierId) ctxInfo.push(`Existing supplier "${supplierName}" ID: ${supplierId} — do NOT create again, use this ID directly`);
  }
  if (ctxInfo.length > 0) {
    parts.push(`\nResources already created in this session:\n${ctxInfo.join("\n")}`);
  }

  parts.push(
    `\nDetected language: ${task.language}`,
    `\nTask type hint: ${task.taskType}`,
    `\nToday's date: ${new Date().toISOString().slice(0, 10)}`,
    `\nExecute the necessary API calls now.`,
  );

  return parts.join("\n");
}

function isIdEndpoint(endpoint: string): boolean {
  return /\/\d+$/.test(endpoint) || /\/\d+\/\w+$/.test(endpoint);
}

const KNOWN_BETA_PATTERNS = [
  "/customer/list", "/invoice/list", "/order/list", "/project/list",
  "/incomingInvoice", "/documentArchive", "/company/salesmodules",
];

/**
 * Fix voucher postings that use row 0 (system-reserved, always causes 422).
 * Re-numbers rows starting at 1. Also strips extra fields from account objects
 * that cause validation errors (only {id} is needed).
 */
function fixVoucherPostings(body: Record<string, unknown>): void {
  const postings = body.postings;
  if (!Array.isArray(postings)) return;
  for (let i = 0; i < postings.length; i++) {
    const p = postings[i] as Record<string, unknown>;
    p.row = i + 1;
    const account = p.account as Record<string, unknown> | undefined;
    if (account && account.id !== undefined) {
      p.account = { id: account.id };
    }
  }
}

let cachedDefaultDeptId: number | null = null;

async function autoFixPostBody(
  client: TripletexClient,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (endpoint === "/employee" || endpoint.endsWith("/employee")) {
    if (!body.department) {
      if (!cachedDefaultDeptId) {
        try {
          const res = await client.list<{ id: number }>("/department", { from: "0", count: "1" });
          if (res.values[0]) cachedDefaultDeptId = res.values[0].id;
        } catch { /* ignore */ }
      }
      if (cachedDefaultDeptId) {
        body.department = { id: cachedDefaultDeptId };
      }
    }
    const ut = String(body.userType ?? "").toUpperCase();
    if (!ut || ut === "0") {
      body.userType = body.email ? "EXTENDED" : "STANDARD";
    }
  }
}

function enrich403Error(endpoint: string, errorMsg: string): string {
  const isBetaLikely = KNOWN_BETA_PATTERNS.some((p) => endpoint.includes(p)) || errorMsg.includes("403");
  if (isBetaLikely && errorMsg.includes("403")) {
    const base = endpoint.replace(/\/list$/, "");
    return `${errorMsg}\n\n⚠️ This endpoint is likely [BETA] and returns 403 in the competition sandbox. Do NOT retry this endpoint. Use an alternative: for batch /list endpoints, use repeated single POST to ${base} instead. For other BETA endpoints, check the api_search tool for alternatives.`;
  }
  return errorMsg;
}

export function resetGenericHandlerCache(): void {
  cachedDefaultDeptId = null;
}

export async function handleGenericTask(
  client: TripletexClient,
  task: ParsedTask,
  ctx: SequenceContext,
): Promise<void> {
  console.log(
    `[GenericHandler] Starting agentic execution for: ${task.taskType}`,
  );
  console.log(`[GenericHandler] Prompt: ${task.rawPrompt.slice(0, 200)}...`);

  const tools: GeminiToolDef[] = [
    {
      name: "tripletex_get",
      description:
        "Make a GET request to the Tripletex API. Use for searching/listing resources. For list endpoints, returns { values: [...], fullResultSize }. For single-object endpoints (with ID), returns { value: {...} }.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path, e.g. "/employee", "/ledger/account", "/invoice/123"',
          },
          params: {
            type: "object",
            description: 'Query parameters as string key-value pairs, e.g. { "name": "Acme", "from": "0", "count": "10" }',
          },
        },
        required: ["endpoint"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const params = args.params as Record<string, string> | undefined;
        console.log(`[GenericHandler] GET ${endpoint} ${params ? JSON.stringify(params) : ""}`);
        try {
          if (isIdEndpoint(endpoint)) {
            const result = await client.get<unknown>(endpoint, params);
            return { success: true, value: result.value };
          }
          const result = await client.list<unknown>(endpoint, params);
          return {
            success: true,
            fullResultSize: result.fullResultSize,
            count: result.values.length,
            values: result.values,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] GET ${endpoint} failed: ${msg}`);
          return { success: false, error: enrich403Error(endpoint, msg) };
        }
      },
    },
    {
      name: "tripletex_post",
      description: "Make a POST request to the Tripletex API. Use for creating new resources.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path, e.g. "/employee", "/customer"',
          },
          body: {
            type: "object",
            description: "JSON body for the request",
          },
        },
        required: ["endpoint", "body"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const body = args.body as Record<string, unknown>;
        if (endpoint.includes("/ledger/voucher") && !endpoint.includes("/list")) {
          fixVoucherPostings(body);
        }
        await autoFixPostBody(client, endpoint, body);
        console.log(`[GenericHandler] POST ${endpoint} ${JSON.stringify(body).slice(0, 300)}`);
        try {
          const result = await client.post<unknown>(endpoint, body);
          return { success: true, value: result.value };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] POST ${endpoint} failed: ${msg}`);
          return { success: false, error: enrich403Error(endpoint, msg) };
        }
      },
    },
    {
      name: "tripletex_put",
      description: "Make a PUT request with a JSON body. Use for updating existing resources (include id and version).",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path with ID, e.g. "/employee/123", "/company"',
          },
          body: {
            type: "object",
            description: "JSON body for the request. Must include id and version fields for most resources.",
          },
        },
        required: ["endpoint", "body"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const body = args.body as Record<string, unknown>;
        console.log(`[GenericHandler] PUT ${endpoint} ${JSON.stringify(body).slice(0, 300)}`);
        try {
          const result = await client.put<unknown>(endpoint, body);
          return { success: true, value: result.value };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] PUT ${endpoint} failed: ${msg}`);
          return { success: false, error: enrich403Error(endpoint, msg) };
        }
      },
    },
    {
      name: "tripletex_put_action",
      description:
        'Make a PUT request with QUERY PARAMETERS (no body). Use for action endpoints like "PUT /invoice/{id}/:payment", "PUT /travelExpense/:deliver", etc. These endpoints use query params instead of a JSON body.',
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path with action, e.g. "/invoice/123/:payment"',
          },
          params: {
            type: "object",
            description: 'Query parameters as string key-value pairs, e.g. { "paymentDate": "2026-03-20", "paymentTypeId": "123", "paidAmount": "10000" }',
          },
        },
        required: ["endpoint", "params"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const params = args.params as Record<string, string>;
        const qs = new URLSearchParams(params).toString();
        const fullEndpoint = `${endpoint}?${qs}`;
        console.log(`[GenericHandler] PUT-ACTION ${fullEndpoint}`);
        try {
          const result = await client.put<unknown>(fullEndpoint, undefined);
          return { success: true, value: result.value };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] PUT-ACTION ${fullEndpoint} failed: ${msg}`);
          return { success: false, error: enrich403Error(fullEndpoint, msg) };
        }
      },
    },
    {
      name: "tripletex_post_list",
      description:
        "Make a POST request with an ARRAY body to a /list endpoint. Use for batch creating multiple resources at once (e.g. POST /department/list, POST /product/list). Returns { values: [...] }.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API list endpoint path, e.g. "/department/list", "/product/list"',
          },
          body: {
            type: "array",
            items: { type: "object" },
            description: "Array of JSON objects to create",
          },
        },
        required: ["endpoint", "body"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const body = args.body as Record<string, unknown>[];
        console.log(`[GenericHandler] POST-LIST ${endpoint} (${body.length} items)`);
        try {
          const result = await client.postList<unknown>(endpoint, body);
          return {
            success: true,
            count: result.values.length,
            values: result.values,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] POST-LIST ${endpoint} failed: ${msg}`);
          return { success: false, error: enrich403Error(endpoint, msg) };
        }
      },
    },
    {
      name: "tripletex_delete",
      description: "Make a DELETE request to the Tripletex API. Use for removing resources.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path with ID, e.g. "/employee/123", "/travelExpense/456"',
          },
        },
        required: ["endpoint"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        console.log(`[GenericHandler] DELETE ${endpoint}`);
        try {
          await client.delete(endpoint);
          return { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] DELETE ${endpoint} failed: ${msg}`);
          return { success: false, error: enrich403Error(endpoint, msg) };
        }
      },
    },
    {
      name: "api_search",
      description:
        "Search the Tripletex API documentation for endpoints matching a keyword. Only use for UNFAMILIAR endpoints not covered by the RECIPES in the system prompt. Skip this for payroll, supplier invoices, dimensions, and timesheets — those recipes are complete.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'Search query, e.g. "salary", "bank reconciliation", "asset", "incoming invoice"',
          },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const query = args.query as string;
        console.log(`[GenericHandler] API-SEARCH: "${query}"`);
        return { docs: searchEndpoints(query, 8) };
      },
    },
    {
      name: "api_endpoint_detail",
      description:
        "Get detailed documentation for a specific API endpoint (path + method). Returns parameters, required fields, and response schema.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'API path, e.g. "/salary/payslip"',
          },
          method: {
            type: "string",
            description: 'HTTP method, e.g. "GET", "POST"',
          },
        },
        required: ["path", "method"],
      },
      execute: async (args) => {
        const path = args.path as string;
        const method = args.method as string;
        console.log(`[GenericHandler] API-DETAIL: ${method} ${path}`);
        return { docs: getEndpointDetail(path, method) };
      },
    },
  ];

  const { text, steps, toolCalls } = await geminiGenerateWithTools({
    model: config.google.model,
    system: buildSystemPrompt(),
    prompt: buildUserPrompt(task, ctx),
    tools,
    maxSteps: MAX_STEPS,
    maxTokens: 16384,
  });

  console.log(
    `[GenericHandler] Completed in ${steps} step(s), ${toolCalls} tool call(s)`,
  );
  if (text) {
    console.log(`[GenericHandler] Summary: ${text.slice(0, 500)}`);
  }
}
