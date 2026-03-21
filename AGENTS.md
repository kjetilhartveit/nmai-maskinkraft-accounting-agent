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

### Dedicated handlers

See [`src/handlers/index.ts`](src/handlers/index.ts) for the complete list of handlers with their typical API call counts. Each handler entry includes a comment describing its API call pattern.

The `unknown` task type falls back to [`generic-handler.ts`](src/handlers/generic-handler.ts) which uses an LLM agentic loop (4-25 calls).

### SequenceContext

Handlers share state via `SequenceContext` which tracks IDs for customers, employees, departments, products, orders, and invoices created in earlier tasks. This eliminates redundant GET lookups in multi-task sequences (e.g., create customer → send invoice → register payment).

## Evaluation system

**Never run eval against all tests.** With 100+ cases each taking seconds, a full run wastes time and API quota. Always scope runs to the task type you are working on.

### Eval commands

```bash
# Targeted — run one task type
pnpm eval -- --task-type create_invoice

# Fast — one representative test per task type (16 cases total)
pnpm eval -- --one-per-type

# Focused — top N worst-performing types from solve history
pnpm eval -- --worst 5 --one-per-type

# Combine filters
pnpm eval -- --task-type create_credit_note --tier 2,3
pnpm eval -- --worst 5 --tier 2,3 --one-per-type

# Other flags
pnpm eval -- --filter "credit_note"          # freetext filter on ID/type/prompt
pnpm eval -- --iterations 3                  # repeat for confidence (LLMs are non-deterministic)
pnpm eval -- --update-baselines              # tighten API call bounds after improvements
```

Each case prints a colored PASS/FAIL line immediately as it completes, so you get continuous terminal feedback.

### Task type analysis

```bash
pnpm task-types                        # overview: all types, case counts, tiers, languages
pnpm task-types -- create_invoice      # detail: all variations by language + solve history
pnpm task-types -- --worst             # top 10 failing types from solve database
```

## Feedback loop for solving difficult tasks

Medium and complex tasks (tier 2–3) carry the highest competition score multiplier. Use this loop to systematically fix failing task types.

### Step 1: Identify — find what's failing

```bash
pnpm task-types -- --worst
```

This queries the solve database and ranks task types by failure count. Focus on the type with the most failures or the lowest success rate.

### Step 2: Understand — inspect the task type

```bash
pnpm task-types -- <task_type>
```

This shows all test case variations (by language, tier, multi-task pipelines) and the solve history from the database. Look for patterns: does it fail in a specific language? Only as part of multi-task sequences? Always with the same error?

### Step 3: Diagnose — run a single targeted eval

```bash
pnpm eval -- --task-type <task_type> --one-per-type
```

This runs exactly one test case for that type. Read the PASS/FAIL output and the error message. If the handler code needs investigation, check the relevant file in `src/handlers/`.

For API-level debugging, use `pnpm probe` to test the exact endpoint sequence the handler uses.

### Step 4: Fix — make the change

Fix the handler, prompt, or parsing logic. Common fixes:

- Handler sends wrong fields → update handler code
- LLM parses entities incorrectly → update system prompt in `src/lib/gemini.ts`
- BETA endpoint returns 403 → find non-beta alternative (see BETA section above)
- 422 validation error → use `pnpm probe` to find the correct payload format

### Step 5: Verify — confirm the fix works

```bash
# Quick check: one test
pnpm eval -- --task-type <task_type> --one-per-type

# Broader check: all variations of that type
pnpm eval -- --task-type <task_type>

# Confidence check: repeat (LLM outputs are non-deterministic)
pnpm eval -- --task-type <task_type> --one-per-type --iterations 3
```

### Step 6: Decide — is this task type "solved"?

A task type is considered solved when:

- **`--one-per-type` passes consistently** (3/3 iterations).
- **All variations pass** (`--task-type <type>` without `--one-per-type`), or failures are limited to edge cases that don't reflect competition prompts.
- **`pnpm task-types -- --worst`** no longer lists it near the top.

Once solved, move to the next worst-performing type. Do not re-test solved types unless you change shared code (parser, sequence context, generic handler).

### Key principles

- **Never test everything at once.** A full eval of 100+ cases takes too long and obscures signal. Always scope to 1–5 cases.
- **LLMs are non-deterministic.** A single PASS doesn't mean solved. Run 2–3 iterations for confidence. A single FAIL doesn't necessarily mean broken — check if it reproduces.
- **Work one task type at a time.** Finish the feedback loop for one type before moving to the next.
- **Probe before eval.** If the error is an API 422/403, debug with `pnpm probe` first — it's instant and doesn't require the full agent loop.

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
