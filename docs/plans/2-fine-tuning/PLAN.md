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
- [ ] Fix create_invoice handler to support multiple product lines with different VAT types
- [ ] Fix create_product handler to search for existing products before creating
- [ ] I've noticed you write something about retrieving existing data in our solver - we can do this but only for data we have created in the current run as we should expect the sandbox to be empty. Just check that we're doing this correctly.
- [ ] Are we also detecting information accurately in the prompts? Because that's part of the scoring I think, and we might get points based on that? Can you just check with the official documentation regarding this and our implementation and whether we should make changes to it?
- [ ] We should update our eval test cases to include cases from the actual competition.
- [ ] We'll try solving the test cases to the best of our abilities and update the "expected values" accordingly if we find better solutions.
  - For new test cases we run them in the solver, see errors, and try to iteratively improve on them until we achieve the task without errors and hopefully with less API calls.
- [ ] Continue testing against our sandbox and making iterative improvements. ~~Continue submitting and iterating based on competition results~~
  - We have reached the daily limit, so we should continue against our sandbox and improving our evals.
- [ ] For later it would be useful if we could differentiate our runs with runs from other team members. Perhaps by date (in the UI) or other identifiers. Note that when we submit we also get GET requests (with path submissions) continuously which gives us information about the API calls made.
- [ ] Consider adding previous solutions as inspiration in our system prompt.
- [ ] Could we add a tool for the LLM to retrieve API information? This could be helpful for the LLM, especially if we don't have a handler for it.
- [ ] Keep running our evals (we should have more now due to adding new test cases) and keep iterating on improving them if possible. Fix errors and be creative in case we think we have found the perfect way.

## Findings from competition submission

**Result: 0/13 (0/6 checks)** on first submission with improved logging.

Key issues identified:

1. **Custom accounting dimensions** not supported - competition sent Spanish prompt asking to create custom dimension "Region" with values "Nord-Norge"/"Vestlandet", then create a voucher linked to it. Our LLM parsed this as `create_department → create_voucher` which is incorrect.
2. **Voucher date validation error** - `POST /ledger/voucher` returns 422: "Verdien er ikke av korrekt type for dette feltet" on the `date` field. Fixed by ensuring YYYY-MM-DD format and using `amountGross` for postings.
3. **No graceful degradation** - when one task in a sequence failed, the entire solve crashed. Fixed by catching errors per-task and continuing execution.
4. The competition platform sends `python-httpx/0.28.1` user agent, connects from FI (Finland), and provides a different sandbox URL (`tx-proxy-*-.a.run.app`) not our own sandbox.

### Task types we need to support (from competition observations):

- Custom accounting dimensions (not just departments)
- Vouchers with posting lines linked to dimensions
- Any other Tripletex API operation that may come up

### Previous results from the competition (observed in UI):

- Best: 8/8 (100%) and 7/7 (100%) - so our system CAN work for simpler tasks
- Worst: Multiple 0/7 and 0/8 - failing on tasks we don't support

## Second round of submissions (with generic handler + payment handler)

**Result: 2/7 (29%)** — Portuguese payment task. Check 1 passed (invoice found), Check 2 failed (payment not registered — generic handler couldn't find the correct endpoint). Fixed by creating dedicated payment handler.

**Result: pending** — Portuguese invoice with 3 product lines at different VAT rates (25%, 15%, 0%). Products already existed in sandbox, create_product failed. Invoice created with only 1 line instead of 3.

### Key issues identified (round 2):

1. **Payment endpoint uses query params not body** - `PUT /invoice/{id}/:payment` takes paymentDate, paymentTypeId, paidAmount as query parameters. Generic handler was trying body-based PUT. Fixed with `tripletex_put_action` tool and dedicated handler.
2. **Products may pre-exist in sandbox** - Product numbers can already be in use. Need to search for existing products first.
3. **Invoice handler only creates 1 product line** - When task requires multiple lines with different VAT rates, our handler only creates one. Need to support multi-line invoices.
4. **Generic handler GET crash** - `client.list()` used for single-object endpoints like `/invoice/{id}` causing "Cannot read properties of undefined". Fixed by detecting ID-based endpoints.

### Execution of plan

- You should git commit and push regularly, particularly after making many code changes.
- After every step you should tick the step off the plan and make sure everything is committed and pushed.
- Be autonomous, but if you need my input then ask for it in [QA.md](QA.md).
