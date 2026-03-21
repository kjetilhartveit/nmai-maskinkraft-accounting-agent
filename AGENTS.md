# Information

The purpose of this repository is to work on the task "Accounting Agent" in the Norwegian Championship in AI.

In a nutshell we must build a system where we parse prompts in natural language into API calls to the Tripletex API.

There are many caveats to consider which are well documented in the official documentation and in the [FINDINGS.md](docs/reports/FINDINGS.md).

In order for us to create the best possible system there are many things we need to know first; many of which are mentioned in [RECOMMENDATIONS.md](docs/reports/RECOMMENDATIONS.md).

The system parses natural-language prompts (in Norwegian, Nynorsk, English, Spanish, Portuguese, German, or French) into structured task sequences. Dedicated deterministic handlers execute each task with minimal API calls, while a generic agentic handler covers unsupported task types via LLM tool-calling.

## Agent's role

Your role in this project is of utter importance. As an autonomous senior software engineer with extensive expertise within APIs and creating and utilising LLMs for systems and evaluations, you're a perfect fit for our team! We have huge confidence in your abilities and you have great freedom in achieving the best possible results. But at the same time you do listen to our directions as you want to make sure the user is happy and involved in the process.

## Tech stack

- Runtime: Node.js with TypeScript.
- HTTP Framework: Hono (lightweight, fast, TypeScript-first).
- AI: Google Gemini API (direct REST calls via `src/lib/gemini.ts`).
- Manage dependencies/packages: pnpm.
- Deployment: Cloudflare Tunnel (local dev → HTTPS).

## Links

- **App**: https://app.ainm.no
- **Rules**: https://app.ainm.no/rules
- **Docs overview**: https://app.ainm.no/docs
- **Docs - Task Accounting Agent**: https://app.ainm.no/docs/tripletex/overview
- **Task submission**: https://app.ainm.no/submit/tripletex
- **Tripletex API documentation**: https://kkpqfuj-amager.tripletex.dev/v2-docs/
- **Prizes and how it works**: https://app.ainm.no/prizes
- **Team**: Maskinkraft

## API exploration workflow

Before running full eval tests, validate endpoints directly against the sandbox using `pnpm probe`. This is the fastest way to learn how endpoints behave, discover required fields, and verify fixes.

### Quick validation (one-shot)

```bash
pnpm probe GET /employee '{"from":"0","count":"2"}'
pnpm probe POST /department '{"name":"Test"}'
pnpm probe GET /ledger/vatType '{"from":"0","count":"100"}'
pnpm probe DELETE /department/12345
```

### Interactive REPL

```bash
pnpm probe
probe> GET /employee
probe> POST /customer {"name":"Acme AS","isCustomer":true}
probe> GET /invoice {"invoiceDateFrom":"2026-01-01","invoiceDateTo":"2026-12-31"}
probe> stats
probe> log
```

### Recommended workflow

1. **Discover** — Use `pnpm probe` to explore unfamiliar endpoints and understand their response shapes.
2. **Validate** — When fixing a handler or adding support for a new task type, probe the exact endpoint sequence first to confirm it works.
3. **Iterate** — If a POST returns 422, read the error, adjust the payload, and retry immediately in the REPL — no need to run the full agent loop.
4. **Apply** — Once the working endpoint pattern is confirmed, update the handler/prompt and run `pnpm eval` to verify end-to-end.

Other sandbox tools: `pnpm test:sandbox` (connectivity smoke test), `pnpm reset-sandbox` (clean up dev sandbox).

## BETA endpoint restrictions (critical)

Tripletex is a module-based accounting system. Many endpoints marked `[BETA]` in the Swagger docs return **403 Forbidden** in the competition sandbox. This was the #1 source of errors in submissions.

### Key rules

- **403 = likely BETA.** If an endpoint returns 403, do not retry it — find a non-beta alternative.
- **Batch `/list` endpoints that are BETA:** `/customer/list`, `/invoice/list`, `/order/list`, `/project/list`. Use repeated single `POST` calls instead.
- **Safe batch `/list` endpoints (non-beta):** `/department/list`, `/product/list`, `/employee/list`, `/supplier/list`, `/ledger/account/list`.
- **Employee entitlements** (`POST /employee/entitlement`) are BETA but often work. Common failure: employee must have `userType: "EXTENDED"` before entitlements can be granted. The first sandbox employee usually has PM rights already.
- **Incoming invoice** endpoints are all BETA. Use voucher postings as an alternative (debit expense + debit input VAT + credit 2400). **Critical**: the credit posting to account 2400 (accounts payable) MUST include `supplier: {id}` or the voucher will fail with 422.
- **Salary/payroll** endpoints (`/salary/transaction`, `/salary/payslip`) often return 403. Use manual voucher on salary accounts (5000-series) instead.
- **`POST /company/salesmodules`** is BETA. Modules cannot be activated via API.
- **Project update/delete** (`PUT /project/{id}`, `DELETE /project/{id}`) are BETA.
- **`DELETE /customer/{id}`** is BETA.
- Some BETA endpoints work (e.g. `GET /project/{id}`), but this is unreliable.

### How it's handled in the codebase

- `api-index.json` (built via `pnpm build-api-index`) provides endpoint metadata with `beta: true/false` flags. The generic handler's `api_search` / `api_endpoint_detail` tools show `[BETA]` warnings.
- Generic handler system prompt explicitly lists forbidden beta endpoints and safe alternatives.
- 403 errors in tool responses are enriched with "this is likely a BETA endpoint" guidance.
- Dedicated handlers use single POST calls instead of beta batch endpoints.

### Probe first, learn, then apply

Use `pnpm probe` to quickly test whether an endpoint works before building it into a handler. If it returns 403, document it and find the non-beta alternative.

## Handler architecture

The system uses a hybrid approach: Gemini LLM parses natural-language prompts into structured task sequences, then **dedicated deterministic handlers** execute each task with minimal API calls. Unrecognized tasks fall back to a **generic agentic handler** that uses LLM tool-calling against the Tripletex API.

### Dedicated handlers (in `src/handlers/`)

| Task type | Handler | Typical API calls |
|-----------|---------|-------------------|
| `create_employee` | `create-employee.ts` | 2-3 (dept + dedup + POST) |
| `update_employee` | `update-employee.ts` | 2-3 (find + GET + PUT) |
| `create_customer` | `create-customer.ts` | 1-2 (POST, retry without address on 422) |
| `update_customer` | `update-customer.ts` | 2-3 (find + GET + PUT) |
| `create_department` | `create-department.ts` | 1 (batch POST /list) |
| `create_supplier` | `create-supplier.ts` | 1 (POST or batch) |
| `create_product` | `create-product.ts` | 3-5 (dept + VAT + unit + POST, retries without vatType on rejection) |
| `create_order` | `create-order.ts` | 3-8 (customer + products + order + lines) |
| `create_invoice` / `send_invoice` | `create-invoice.ts` | 5-7 (bank config + order + invoice + send) |
| `create_payment` | `create-payment.ts` | 3-5 (find invoice + payment type + PUT) |
| `create_credit_note` | `create-credit-note.ts` | 6-8 (find/create invoice + credit) |
| `create_project` | `create-project.ts` | 3-8 (PM entitlements + POST) |
| `create_voucher` | `create-voucher.ts` | 2-5 (account lookups + POST) |
| `create_travel_expense` | `create-travel-expense.ts` | 4-7 (employee + POST + paymentType + costs) |
| `create_payroll` | `create-payroll.ts` | 5-7 (employee + 3 accounts + voucher) |
| `create_supplier_invoice` | `create-supplier-invoice.ts` | 4-5 (3 accounts + voucher, supplier from ctx) |
| `create_dimension` | `create-dimension.ts` | 5-8 (dimension + values + 2 accounts + voucher with dimension link) |
| `unknown` | `generic-handler.ts` | 4-25 (LLM agentic loop) |

### SequenceContext

Handlers share state via `SequenceContext` which tracks IDs for customers, employees, departments, products, orders, and invoices created in earlier tasks. This eliminates redundant GET lookups in multi-task sequences (e.g., create customer → send invoice → register payment).

## Evaluation system

Run `pnpm eval` to test all cases against the sandbox. Use `--filter` to test specific cases.

```bash
pnpm eval                                    # run all test cases
pnpm eval -- --filter "credit_note"          # filter by ID/type
pnpm eval -- --filter "order" --iterations 3 # run 3 times for confidence
pnpm eval -- --update-baselines              # tighten API call bounds
```

# Environment variables

A full list of the environment variables can be found in [.env.example](.env.example). We should make sure to keep the environment variables up-to-date.

# The docs folder

[docs](docs/) may contain useful resources for agents when executing tasks.

- [plans](docs/plans/): long lasting plans with descriptions, implementation details and checklists.

# AI-generated commit messages

When generating a commit message then follow these rules:

- follow the rules for conventional commits.
  - `fix` for changes in behavior
  - `refactor` when having rewritten code and does not change behavior.
  - `docs` when only documentation has changed.
  - `chore` for other things not affecting behavior in the application.
  - when updating dependencies then use `fix(deps)` for changes in production dependencies (`dependencies` in [package.json](package.json)) and use `chore(deps)` for changes in development dependencies (`devDependencies` in [package.json](package.json)).
- keep the commit message short and concise
- follow the pattern from existing commit messages.
