# Findings Report: NM i AI 2026 - Tripletex Accounting Agent

## Competition Context

**NM i AI 2026** is the Norwegian Championship in AI, running March 19-22, 2026 (69 hours). Prize pool: **1,000,000 NOK**. There are 3 tasks, each weighted equally (33.33%). Our focus is **Task 1: Tripletex (AI Accounting Agent)**.

The overall score = average of normalized scores across all 3 tasks. Skipping a task means 0 for that task, so participating in all three is important.

---

## What the Tripletex Task Is (In Simple Terms)

**The big picture:** We build a web server with a single endpoint (`/solve`). The competition system sends us an accounting task in natural language (like "Create an employee named Ola Nordmann with email ola@example.com"). Our agent reads the task, figures out which API calls to make to Tripletex (a real Norwegian accounting system), makes those calls, and returns `{"status": "completed"}`. The system then checks if we did it correctly.

**Think of it like this:** You're given a Tripletex accounting system and a human-language instruction. You need to translate that instruction into API calls — essentially acting as an automated accountant.

---

## Technical Architecture

### The Flow

```
Competition System → POST /solve → Our Agent → Tripletex API (via proxy) → Competition verifies result
```

1. We submit our HTTPS endpoint URL to the platform
2. For each test: a fresh, empty Tripletex sandbox is provisioned
3. Our `/solve` endpoint receives a JSON payload with:
   - `prompt` — the task description (in 1 of 7 languages!)
   - `tripletex_credentials` — `base_url` and `session_token` for API auth
   - `files` — optional PDF/image attachments (base64 encoded)
4. Our agent parses the prompt, plans API calls, executes them against the Tripletex proxy
5. We return `{"status": "completed"}`
6. The system verifies field-by-field what we created/modified

### Authentication

- **Tripletex API:** Basic Auth with username `0` and the `session_token` as password
- **Our endpoint (optional):** We can set an API key that the system sends as `Authorization: Bearer <key>`

### Constraints

| Constraint | Value |
|-----------|-------|
| Timeout | 300 seconds (5 minutes) |
| Protocol | HTTPS required |
| API access | Only through provided proxy URL |
| Sandbox state | Fresh (empty) for each submission |
| Languages | Norwegian, English, Spanish, Portuguese, Nynorsk, German, French |

---

## Scoring System Explained

### 1. Correctness (0.0 to 1.0)

Each task has specific "checks" with point values. Example for "Create employee":

| Check | Points |
|-------|--------|
| Employee found | 2 |
| Correct first name | 1 |
| Correct last name | 1 |
| Correct email | 1 |
| Admin role assigned | 5 |
| **Total** | **10** |

`correctness = points_earned / max_points`

### 2. Tier Multiplier

| Tier | Multiplier | Description | Release |
|------|-----------|-------------|---------|
| Tier 1 | ×1 | Simple operations (create employee/customer) | Immediately |
| Tier 2 | ×2 | Multi-step workflows (invoice + payment) | Early Friday |
| Tier 3 | ×3 | Complex scenarios (reconciliation, year-end) | Early Saturday |

`base_score = correctness × tier_multiplier`

### 3. Efficiency Bonus (up to ×2, only if correctness = 1.0)

This is the differentiator for top teams. Only awarded when you get 100% correctness:

- **Call efficiency:** Fewer API calls = higher bonus (compared to best-known solution)
- **Error cleanliness:** 4xx errors (400, 404, 422) reduce the bonus

**Score examples for a Tier 2 task:**
| Scenario | Score |
|----------|-------|
| Failed checks | 0.0 |
| 80% correct | 1.6 |
| Perfect but many errors | ~2.1 |
| Perfect, efficient, few errors | ~2.6 |
| Perfect, best-in-class, zero errors | 4.0 (maximum) |

### 4. Maximum Possible Score

**6.0** per task = Tier 3 (×3) with perfect efficiency bonus (×2).

### 5. Leaderboard

- Total score = sum of best scores across all 30 task types
- Best score per task is kept forever (bad submissions don't hurt)
- Benchmarks recalculate every 12 hours
- 30 tasks × 6.0 max = **180.0 theoretical maximum**

---

## Task Categories

The 30 task types cover these accounting workflows:

| Category | Example Operations |
|----------|-------------------|
| **Employee management** | Create employees, set roles, update contact info |
| **Customer management** | Register customers, update details |
| **Product registration** | Add products to the system |
| **Invoice operations** | Create invoices, process payments |
| **Travel expenses** | Document travel costs with receipts |
| **Project management** | Create projects, link to departments |
| **Accounting corrections** | Fix ledger entries, reconciliation |
| **Department setup** | Create departments, enable modules |

Tasks range from a single API call to multi-step workflows requiring resource creation and linking.

---

## The 7 Languages

Prompts come in: **Norwegian (Bokmål), Nynorsk, English, Spanish, Portuguese, German, French**

This means our agent must handle multilingual natural language understanding.

---

## Key Tripletex API Endpoints

| Endpoint | Operations |
|----------|-----------|
| `/employee` | GET, POST |
| `/customer` | GET, POST |
| `/product` | GET, POST |
| `/invoice` | GET, POST |
| `/order` | GET, POST |
| `/travelExpense` | GET, POST |
| `/project` | GET, POST |
| `/department` | GET, POST |
| `/ledger/account` | GET, POST |
| `/ledger/posting` | GET, POST |
| `/ledger/voucher` | GET, POST |

**API patterns:**
- `fields` parameter for selective field retrieval (e.g., `?fields=id,firstName,lastName`)
- Pagination with `from` and `count` parameters
- List responses: `{"fullResultSize": N, "values": [...]}`
- DELETE uses ID in URL path (e.g., `DELETE /employee/123`)

---

## Rate Limits

| Team Status | Concurrent Submissions | Per Task Daily |
|------------|----------------------|---------------|
| Verified (Vipps) | 3 | 5 |
| Unverified | 1 | 2 |

**Implication:** Get Vipps-verified ASAP for 3× more testing throughput.

---

## Biggest Hurdles and Blockers

### 1. Multi-language Prompt Parsing (HIGH)
The agent must extract structured task requirements from natural language in 7 different languages. This is the core challenge — if we can't correctly understand what's being asked, nothing else matters.

### 2. Tripletex API Domain Knowledge (HIGH)
Tripletex is a full-featured accounting system with hundreds of endpoints and complex field requirements. Getting the exact right fields, relationships, and values requires deep API knowledge. The sandbox starts empty each time, so we may need to create prerequisite resources (e.g., create a customer before creating an invoice for that customer).

### 3. Efficiency vs. Correctness Trade-off (MEDIUM)
The efficiency bonus rewards minimal API calls with zero errors. This means we can't do "trial and error" — we need to get it right on the first try. But being too aggressive with fewer calls risks missing correctness points.

### 4. File Attachment Processing (MEDIUM)
Some tasks include PDF/image files (like receipts for travel expenses). We need to extract relevant data from these attachments using OCR or multimodal LLM capabilities.

### 5. Resource Dependencies (MEDIUM)
Multi-step tasks require creating resources in the right order. For example, an invoice task might need: create customer → create product → create invoice → register payment. Missing a dependency step means the whole task fails.

### 6. Fresh Sandbox Per Submission (LOW-MEDIUM)
Each submission starts with an empty Tripletex instance. No pre-populated data. This means every dependency must be created from scratch within the 5-minute window.

### 7. Tier 3 Complexity (HIGH)
Tier 3 tasks (reconciliation, year-end closing) are complex accounting operations worth the most points. Understanding these accounting concepts and translating them to API calls will be the biggest technical challenge.

---

## Competition Timeline for Our Task

| When | What |
|------|------|
| **Thu Mar 19, 18:00** | Kickoff — Tier 1 tasks available |
| **Fri (early)** | Tier 2 tasks unlock |
| **Sat (early)** | Tier 3 tasks unlock |
| **Sun Mar 22, 15:00** | Deadline |

This gives us ~69 hours total, but we should have the agent ready to submit from the start.

---

## Key Code Example from Docs

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()

@app.post("/solve")
async def solve(request: Request):
    body = await request.json()
    prompt = body["prompt"]
    files = body.get("files", [])
    creds = body["tripletex_credentials"]

    base_url = creds["base_url"]
    session_token = creds["session_token"]

    # Parse prompt → plan API calls → execute → verify
    # ...

    return JSONResponse({"status": "completed"})
```

**API call example:**
```python
import requests

# List employees
resp = requests.get(
    f"{base_url}/employee",
    auth=("0", session_token),
    params={"fields": "id,firstName,lastName,email"}
)
employees = resp.json()["values"]

# Create customer
resp = requests.post(
    f"{base_url}/customer",
    auth=("0", session_token),
    json={"name": "Acme AS", "email": "post@acme.no", "isCustomer": True}
)
customer_id = resp.json()["value"]["id"]
```

---

## What We Need to Build

A hosted HTTPS endpoint that:
1. Receives a task prompt (in any of 7 languages) + optional file attachments
2. Uses an LLM to parse and understand the task
3. Plans the correct sequence of Tripletex API calls
4. Executes those calls efficiently (minimal calls, zero errors)
5. Returns `{"status": "completed"}`

All within 5 minutes, deployed somewhere accessible via HTTPS.

---

## Optimization Findings (2026-03-22)

### Eval Results: 25/25 non-file tasks pass, 0 API errors

Total Tripletex calls per full eval: **115** (down from 118 before optimizations).

### Key Optimizations Applied

1. **Product catalog batching** (`create-invoice`, `create-order`): When resolving ≥2 products, a single unfiltered `GET /product` loads the full catalog (~82 products in sandbox) into an in-memory map. Products are then resolved by name/number without additional API calls. Savings: 2 calls for 3-product invoices (8→6), 1 call for 2-product orders (5→4).

2. **Lazy payment type loading** (`reminder-fee`): Moved `GET /invoice/paymentType` out of the upfront parallel batch. Now only fetched right before registering the partial payment on the overdue invoice. Saves 1 call when no overdue invoice exists in the sandbox.

3. **Parallelized initial lookups**:
   - `ledger-analysis`: PM employee + department + 2 voucher period queries now run in a single `Promise.all` instead of sequentially (same call count, ~40% latency reduction).
   - `project-lifecycle`: Customer + PM + department lookups now parallel (same call count, faster execution).

4. **Fixed missing cache resets**: `resetReminderFeeCache()` and `resetBankReconciliationCache()` were not called in `solve.ts`, causing the `cachedPaymentTypeId` and bank reconciliation account cache to leak between solve requests. This caused non-deterministic eval results (sometimes 9 calls, sometimes 10 for reminder_fee).

### API Call Counts by Task Type (canonical tests)

| Task Type | Calls | Notes |
|-----------|-------|-------|
| create_customer | 1 | POST /customer |
| create_department | 1 | POST /department/list (batch) |
| create_supplier | 1 | POST /supplier |
| create_employee | 2 | GET /department + GET /employee |
| create_travel_expense | 2 | GET /employee + POST /travelExpense |
| year_end_closing | 2 | GET /ledger/account + POST voucher |
| monthly_closing | 2 | GET /ledger/account + POST voucher |
| create_payroll | 3 | GET /employee + GET /ledger/account + POST voucher |
| create_supplier_invoice | 3 | POST /supplier + GET /ledger/account + POST voucher |
| fx_payment | 3 | GET /invoice + GET /ledger/account + POST voucher |
| create_product | 4 | dept + vatType + unit + product search |
| create_project | 4 | employee + dept + customer + POST project |
| create_payment | 4 | account + invoice + paymentType + PUT payment |
| create_order | 4 | customer + order + catalog + orderlines (batch) |
| create_dimension | 4 | dimensions + values + accounts + voucher |
| reverse_payment | 4 | customer + invoice + paymentType + PUT |
| create_timesheet | 4 | employee + project + activity + entry |
| ledger_audit | 4 | 2× voucher search + accounts + voucher |
| create_invoice | 6 | customer + account + order + catalog + orderlines + invoice |
| send_invoice | 7 | customer + account + order + product + orderline + invoice + send |
| create_credit_note | 8 | customer + account + invoice + product + order + orderline + invoice + credit |
| project_fixed_price | 9 | customer + employee + dept + project + account + product + order + orderline + invoice |
| ledger_analysis | 10 | employee + dept + 2× vouchers + 3× (project + activity) |
| reminder_fee | 10 | invoices + accounts + voucher + product + order + orderline + invoice + send + paymentType + payment |
| project_lifecycle | 13 | customer + dept + employee + project + activity + 2× timesheet + accounts + voucher + product + order + orderline + invoice |
