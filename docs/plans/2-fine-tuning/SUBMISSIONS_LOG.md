# Key findings (round 3):

1. **Employee userType** — valid values are `NO_ACCESS`, `STANDARD`, `EXTENDED`. There is NO `ADMINISTRATOR` value. Admin roles are granted via `POST /employee/entitlement`.
2. **Entitlement API format** — requires `{ employee: {id}, entitlementId: <number>, customer: {id: <companyId>} }`, NOT `{ entitlement: "name" }`.
3. **EXTENDED access required** — Entitlements (ROLE_ADMINISTRATOR, AUTH_PROJECT_MANAGER) can only be granted to employees with `userType: "EXTENDED"`.
4. **PROJECT_MANAGER prerequisite** — AUTH_PROJECT_MANAGER (entitlementId 10) requires AUTH_CREATE_PROJECT (entitlementId 45) first.
5. **userType is write-once** — Setting userType via PUT doesn't work; must be set during creation.
6. **Product caching** — SequenceContext now caches product IDs between create_product and create_invoice handlers, reducing API calls by 3-8 per multi-line invoice.
7. **maxTokens** — Set to 4096 for LLM parsing and 16384 for generic handler to avoid OpenRouter credit issues.

# Findings from competition submission

**Result: 0/13 (0/6 checks)** on first submission with improved logging.

Key issues identified:

1. **Custom accounting dimensions** not supported - competition sent Spanish prompt asking to create custom dimension "Region" with values "Nord-Norge"/"Vestlandet", then create a voucher linked to it. Our LLM parsed this as `create_department → create_voucher` which is incorrect.
2. **Voucher date validation error** - `POST /ledger/voucher` returns 422: "Verdien er ikke av korrekt type for dette feltet" on the `date` field. Fixed by ensuring YYYY-MM-DD format and using `amountGross` for postings.
3. **No graceful degradation** - when one task in a sequence failed, the entire solve crashed. Fixed by catching errors per-task and continuing execution.
4. The competition platform sends `python-httpx/0.28.1` user agent, connects from FI (Finland), and provides a different sandbox URL (`tx-proxy-*-.a.run.app`) not our own sandbox.

## Task types we need to support (from competition observations):

- Custom accounting dimensions (not just departments)
- Vouchers with posting lines linked to dimensions
- Any other Tripletex API operation that may come up

# Previous results from the competition (observed in UI):

- Best: 8/8 (100%) and 7/7 (100%) - so our system CAN work for simpler tasks
- Worst: Multiple 0/7 and 0/8 - failing on tasks we don't support

# Second round of submissions (with generic handler + payment handler)

**Result: 2/7 (29%)** — Portuguese payment task. Check 1 passed (invoice found), Check 2 failed (payment not registered — generic handler couldn't find the correct endpoint). Fixed by creating dedicated payment handler.

**Result: pending** — Portuguese invoice with 3 product lines at different VAT rates (25%, 15%, 0%). Products already existed in sandbox, create_product failed. Invoice created with only 1 line instead of 3.

## Key issues identified (round 2):

1. **Payment endpoint uses query params not body** - `PUT /invoice/{id}/:payment` takes paymentDate, paymentTypeId, paidAmount as query parameters. Generic handler was trying body-based PUT. Fixed with `tripletex_put_action` tool and dedicated handler.
2. **Products may pre-exist in sandbox** - Product numbers can already be in use. Need to search for existing products first.
3. **Invoice handler only creates 1 product line** - When task requires multiple lines with different VAT rates, our handler only creates one. Need to support multi-line invoices.
4. **Generic handler GET crash** - `client.list()` used for single-object endpoints like `/invoice/{id}` causing "Cannot read properties of undefined". Fixed by detecting ID-based endpoints.
