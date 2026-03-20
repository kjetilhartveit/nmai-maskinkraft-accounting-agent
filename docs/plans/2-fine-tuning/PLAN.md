# Fine-tuning

We have set up the project, but we must fine-tune our solution, fix bugs and set ourselves up for success in the competition.

## Plan

- [x] Our real-life submission is failing with 4/4 checks failed. I still see no output from the live submit, please make sure we store the prompts, the results, the errors, everything. And print it to the terminal and log it.
  - [x] We can also include live submits in the agent dashboard.
- [x] Agent dashboard:
  - [x] We could show one run at the time, and other runs are "archived" in a different tab or something.
- [x] Do not truncate error messages to 200 symbols, show and persist the entire error message. Check thoroughly, we truncate many places today.
- [x] In our test cases we have a `expectedApiCalls` but what is actually interesting is the entities that are created or the action that must be done in order to complete the task (remember it's important that we get this right with the correct entitities!). Actual tool calls is something we can also test on, but the most interesting part is that we examine how few tool calls are used in the solution. If we can find a solution which uses fewer API calls and have no errors than the test case, then we should update the test case to reflect this so we don't regress.
  - [x] This feedback loop in the evals should be automated so we can continuously improve the eval system.
- [x] I think we can reduce the number of API calls in our evals, sometimes we create department twice and employees twice when we only need to do it once.
- [x] We should attempt to submit a solution to the competition. Use the browser tool and window to click the submit button, consider the results coming in and act upon them.
- [x] Note that our solution must not be too rigid with specific tasks, the Tripletex API is quite vast and our system prompt does not cover all the of them. The tool must have a way to access either the official API for reference or our own documentation (if we have a local reference).
  - [x] Created generic agentic handler (`generic-handler.ts`) using Vercel AI SDK tool-calling
  - [x] Created condensed Tripletex API reference (`tripletex-api-reference.ts`) covering all major endpoints
  - [x] Unknown task types now fall through to the generic handler instead of being skipped
  - [x] Improved LLM parsing to correctly classify unknown tasks (especially accounting dimensions)
- [x] Created dedicated `create_payment` handler for invoice payment registration
  - Uses `PUT /invoice/{id}/:payment` with query parameters (not body)
  - Searches for existing invoices before creating new ones
- [x] Fix create_invoice handler to support multiple product lines with different VAT types
  - Added `extractProductLines()` to parse multiple product entities with per-line VAT rates
  - Added `findVatTypeIdByRate()` helper to resolve VAT types by percentage (0%, 12%, 15%, 25%)
  - Updated LLM prompt to output multi-line invoice entities with vatRate per product
- [x] Fix create_product handler to search for existing products before creating
  - Added `findProductByName()` and `findProductByNumber()` helpers
  - Products are now searched before creation to avoid duplicates
- [x] I've noticed you write something about retrieving existing data in our solver - we can do this but only for data we have created in the current run as we should expect the sandbox to be empty. Just check that we're doing this correctly.
  - Verified: all handlers use search-before-create pattern for deduplication; SequenceContext passes IDs between tasks; payment handler correctly handles pre-existing invoices from competition
- [x] Are we also detecting information accurately in the prompts? Because that's part of the scoring I think, and we might get points based on that? Can you just check with the official documentation regarding this and our implementation and whether we should make changes to it?
  - Scoring: field-by-field checks (correctness 0-1) × tier multiplier × efficiency bonus (only at 100%)
  - Fixed: ADMINISTRATOR userType was invalid API value — now uses entitlements (POST /employee/entitlement)
  - Fixed: project manager now gets PROJECT_MANAGER entitlement before assignment
  - Fixed: LLM prompt now explicitly describes admin role detection across all 7 languages
- [x] We should update our eval test cases to include cases from the actual competition.
  - Added 7 new test cases from competition: dimension+voucher (ES), payment (PT), multi-line invoice (PT), admin role (EN/NO), project manager (DE)
- [x] We'll try solving the test cases to the best of our abilities and update the "expected values" accordingly if we find better solutions.
  - Eval results: 11/16 passed. Updated baselines for 10 test cases with significantly fewer API calls.
  - Multi-line invoice: 12 calls, 0 errors (was untested before)
  - Payment: 4 calls, 0 errors
  - Department batch: 1 call (using /department/list)
  - Dimension+voucher: 20 calls, 7 errors (complex agentic task, voucher postings don't support dimension fields)
- [x] Keep running our evals (we should have more now due to adding new test cases) and keep iterating on improving them if possible. We should not accept any errors and if we think we are perfect, try to be creative in case we can improve even more (especially on more complex cases where we use many API calls).
  - Before credits ran out: 12/16 passing (multiline invoice fixed to 12 calls, admin role entitlements working with correct API format)
  - [x] In the [test-cases.ts](../../../src/eval/test-cases.ts) file we have a few tasks with very high expectedApiCalls (40, 9 and 8) all of these must be down to reasonable numbers. And we should not accept any errors.
    - Optimized: project-de-wind 40→10 (7 in dirty sandbox), admin-role 8→5 (0 errors), invoice 9→8, multi-invoice 15→11, payment 5→4
    - **15/16 eval cases passing** (only comp-dimension-voucher-es fails due to parse/entity matching in generic handler)
    - Key optimizations: skip redundant employee name search when email provided, skip `ensureExtendedAccess` for just-created employees, cache companyId from POST response, skip order search for just-created customers, verify userType write-once before granting entitlements
- [x] For later it would be useful if we could differentiate our runs with runs from other team members. Perhaps by timetamp/date (in the UI) or other identifiers. Note that when we submit we also get GET requests (with path submissions) continuously which gives us information about the API calls made.
  - Added date group headers, session detection (5-min gap grouping), run badges with color coding, and solve IDs in dashboard detail view
- [x] Consider adding previous solutions as inspiration in our system prompt.
  - Added few-shot examples for payment, customer+invoice, custom dimension+voucher, and admin role tasks
- [x] Could we add a tool for the LLM to retrieve API information? This could be helpful for the LLM, especially if we don't have a handler for it.
  - Added `tripletex_post_list` batch creation tool to generic handler for efficiency
  - Updated API reference with correct userType values (STANDARD/EXTENDED/NO_ACCESS) and entitlement format
- [x] Create a script which syncs my prompts in [solves.jsonl](../../../data/solve-logs/solves.jsonl) with the repo [nmai-maskinkraft](../../../../nmai-maskinkraft/) which in turn can be used by the team. We should make sure not to override or add new prompts (only unique).
  - Created `src/scripts/sync-prompts.ts` (`pnpm sync-prompts`) — reads solves.jsonl, deduplicates by normalized prompt text, aggregates best API call stats from successful runs, writes to `tripletex/shared-prompts.json` in the team repo. Supports `--target=` and `--dry-run` flags.
- [x] The problem with jsonl is that it's so unreadable, should we use a different format like an sqldb lite instead? Remember to update existing code to use the sqlite instead of jsonl when we do the switch.
  - Migrated to SQLite (`data/agent.db`) using `better-sqlite3`. Schema: `solves`, `raw_requests`, `captures` tables with indexes on timestamp/source/prompt. Updated all consumers: solve-logger, dashboard, ingest-prompts, feedback-loop, capture-run, sync-prompts. Created `pnpm migrate` script to import existing JSONL data (246 solves, 118 raw requests imported).
- [x] Should we utilise the [tripletex-openapi.json](../../../docs/reports/tripletex-openapi.json) seeing as it's the truth of source of what's possible with the API? This could be helpful for the LLM, especially if we don't have a handler for it. Consider whether we can hook the handlers up or replace the handlers entirely with the openapi?
  - Created `openapi-index.ts` module that loads a pre-built API index (295KB, 800 endpoints from 546 paths). Added `api_search` and `api_endpoint_detail` tools to the generic handler so the LLM can look up unfamiliar endpoints at runtime. Pre-build with `pnpm build-api-index`. Keeps curated manual reference in system prompt + OpenAPI-backed lookup for the full API surface.
- [ ] Keep working on the tests against the sandbox. Remember the goal is not 100% pass rate, because LLMs are non-deterministic. The goal is to create a solid and robust solution and then figure out which solution is the most consistently good.

### Execution of plan

- You should git commit and push regularly, particularly after making many code changes.
- After every step you should tick the step off the plan and make sure everything is committed and pushed.
- Be autonomous, but if you need my input then ask for it in [QA.md](QA.md).
