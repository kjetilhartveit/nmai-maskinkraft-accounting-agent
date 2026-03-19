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
