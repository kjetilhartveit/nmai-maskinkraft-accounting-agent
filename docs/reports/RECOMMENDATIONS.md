# Recommendations: Winning Strategy for the Tripletex Accounting Agent

## Recommended Architecture

### Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Our Agent (FastAPI)                   │
│                                                         │
│  POST /solve                                            │
│    │                                                    │
│    ├─ 1. Prompt Parser (LLM)                           │
│    │     • Multilingual understanding (7 languages)     │
│    │     • Extract: task type, entities, field values    │
│    │     • Process file attachments (PDF/image → text)  │
│    │                                                    │
│    ├─ 2. Task Router                                    │
│    │     • Map parsed task → handler function           │
│    │     • Each task type has a dedicated handler        │
│    │                                                    │
│    ├─ 3. Task Handler (per task type)                   │
│    │     • Knows exact API call sequence                 │
│    │     • Creates dependencies in correct order         │
│    │     • Makes minimal, targeted API calls             │
│    │                                                    │
│    └─ 4. Tripletex API Client                          │
│          • Auth handling (Basic Auth)                    │
│          • Error handling + logging                      │
│          • Response parsing                              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Why This Architecture?

**Hybrid approach: LLM for understanding + deterministic handlers for execution.**

- The LLM is great at understanding multilingual prompts and extracting structured data
- But we do NOT want the LLM making API calls dynamically — that leads to trial-and-error, wasted calls, and 4xx errors
- Instead, the LLM extracts structured parameters, then deterministic code executes the exact right API calls

This gives us **correctness** (deterministic handlers) AND **efficiency** (minimal, pre-planned API calls with zero errors).

---

## Technology Stack

| Component | Recommendation | Why |
|-----------|---------------|-----|
| **Framework** | FastAPI (Python) | Async, fast, matches competition examples |
| **LLM** | Claude API (claude-sonnet-4-20250514) | Strong multilingual, structured output, fast |
| **File processing** | Claude multimodal (vision) | Can read PDFs and images natively |
| **Hosting** | Google Cloud Run | Free GCP account provided, auto-scaling, HTTPS |
| **HTTP client** | `httpx` (async) | Async Tripletex API calls for speed |

### Why Claude as the LLM?

- Excellent at structured extraction across all 7 languages
- Multimodal: can process PDF/image attachments directly
- Tool use / function calling for structured output
- We're already in the Claude ecosystem

### Why Google Cloud Run?

- **Free:** Competition provides GCP accounts
- **HTTPS out of the box:** No cert management
- **Auto-scaling:** Handles concurrent submissions
- **Simple deploy:** `gcloud run deploy --source .`
- **Low latency from Europe:** `europe-north1` region

---

## Implementation Plan

### Phase 1: Foundation (First Priority)

1. **FastAPI skeleton** with `/solve` endpoint
2. **Tripletex API client** with Basic Auth, error logging
3. **LLM prompt parser** that extracts structured task info
4. **Deploy to Cloud Run** and test the submission flow

### Phase 2: Tier 1 Task Handlers

Build dedicated handlers for each Tier 1 task type. These are single-operation tasks:

- `create_employee` — POST /employee with parsed fields
- `create_customer` — POST /customer
- `create_product` — POST /product
- `update_employee` — GET /employee + PUT /employee/{id}
- `create_department` — POST /department
- etc.

**Strategy:** Use the sandbox to discover exact field requirements and valid values for each endpoint. Document what fields are required vs. optional.

### Phase 3: Tier 2 Task Handlers (Multi-step)

These require creating dependencies in order:

- **Invoice workflow:** Create customer → Create product → Create invoice → (optionally) Register payment
- **Travel expense:** Create employee → Create travel expense → Attach receipt → Submit
- **Project linking:** Create department → Create project → Link to department

**Key insight:** Map out dependency graphs for each multi-step task. Build reusable "create-or-find" helpers.

### Phase 4: Tier 3 Task Handlers (Complex Accounting)

- Reconciliation tasks
- Year-end closing procedures
- Accounting corrections / ledger adjustments

**These are worth the most points (×3 multiplier).** Requires deep Tripletex API knowledge. Prioritize understanding these early even if they release later.

### Phase 5: Optimization

- Minimize API calls (efficiency bonus)
- Eliminate all unnecessary GET calls
- Ensure zero 4xx errors in happy path
- Test across all 7 languages

---

## Prompt Parsing Strategy

### The LLM System Prompt

```
You are parsing an accounting task prompt. Extract the following structured information:
- task_type: one of [create_employee, create_customer, create_invoice, ...]
- entities: list of entities to create/modify
- fields: for each entity, the specific field values mentioned
- dependencies: what needs to exist before the main task
- language: detected language of the prompt
```

### Handling 7 Languages

Rather than translating, we ask the LLM to **extract structured data regardless of language**. Claude handles Norwegian, Nynorsk, English, Spanish, Portuguese, German, and French natively. The structured output is always in English/code.

### File Processing

For tasks with attachments:
1. Decode base64 content
2. Pass to Claude's vision API (for images) or as document (for PDFs)
3. Extract relevant data (amounts, dates, receipt details)
4. Include extracted data in the task parameters

---

## Maximizing Score: The Math

### Score Formula
```
task_score = correctness × tier_multiplier × (1 + efficiency_bonus)
```

Where:
- `correctness` ∈ [0, 1]
- `tier_multiplier` ∈ {1, 2, 3}
- `efficiency_bonus` ∈ [0, 1] (only when correctness = 1.0)

### Priority Matrix

| Priority | Focus | Points Impact |
|----------|-------|--------------|
| 1 | Get correctness to 1.0 on every task | Baseline requirement |
| 2 | Cover all 30 task types | More tasks = more points on leaderboard |
| 3 | Optimize efficiency (fewer API calls) | Bonus multiplier |
| 4 | Handle Tier 3 tasks well | 3× multiplier |

### Winning Formula

**Breadth first, depth second.** Cover all 30 task types with perfect correctness before optimizing efficiency on any single task. A team that perfectly handles 30 tasks at base tier scores beats a team that perfectly optimizes 10 tasks.

---

## Critical Success Factors

### 1. Sandbox Exploration (Do This First!)

Before writing any code, spend time in the Tripletex sandbox:
- Explore the web UI to understand accounting concepts
- Test every API endpoint to learn field requirements
- Document required vs. optional fields
- Understand error messages for each endpoint
- Map out resource dependencies

### 2. API Knowledge Base

Build a knowledge base of Tripletex API patterns:

```python
TASK_HANDLERS = {
    "create_employee": {
        "endpoint": "/employee",
        "method": "POST",
        "required_fields": ["firstName", "lastName"],
        "optional_fields": ["email", "phoneNumberMobile", ...],
        "dependencies": [],
    },
    "create_invoice": {
        "endpoint": "/invoice",
        "method": "POST",
        "required_fields": ["customer", "invoiceDate", "orders"],
        "dependencies": ["customer", "product"],
    },
    # ...
}
```

### 3. Error Prevention Over Error Handling

The efficiency bonus penalizes 4xx errors. Our strategy:
- **Never guess** — always know the exact field names and valid values
- **Never retry** — get it right the first time
- **Never search blindly** — use targeted GET calls with filters
- **Validate locally** before sending POST requests

### 4. Deterministic Handlers Over Dynamic LLM Calls

The LLM should only be used for:
- Parsing the prompt into structured data
- Processing file attachments
- (Possibly) handling truly novel/unexpected task formats

The LLM should NOT be used for:
- Deciding which API calls to make (use code routing)
- Constructing API payloads (use templates)
- Error recovery (use deterministic retry logic)

---

## Deployment Strategy

### Development Workflow

1. Develop locally with sandbox credentials
2. Test against sandbox before deploying
3. Deploy to Cloud Run
4. Submit endpoint URL to competition
5. Monitor results on leaderboard
6. Iterate and redeploy

### Cloud Run Configuration

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

```yaml
# Cloud Run settings
memory: 1Gi
cpu: 2
timeout: 300s
max-instances: 3
region: europe-north1
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| LLM latency eating into 5-min timeout | Use fast model (Sonnet), cache system prompts, parallelize where possible |
| Unknown task types | Fallback to dynamic LLM-driven approach for unrecognized tasks |
| Tripletex API quirks | Thorough sandbox testing, document all edge cases |
| File parsing failures | Multiple fallback strategies (Claude vision → OCR → regex) |
| Deployment issues | Test Cloud Run deployment early, have backup deployment option |

---

## What Sets a Winning Solution Apart

1. **100% task type coverage** — handle all 30 task types
2. **Perfect correctness** — every field right on the first try
3. **Minimal API calls** — know exactly what's needed, nothing more
4. **Zero 4xx errors** — never guess, never trial-and-error
5. **Fast execution** — well under the 5-minute limit
6. **Robust multilingual parsing** — all 7 languages equally well
7. **File processing** — correctly handle PDF/image attachments

---

## Immediate Next Steps

1. **Connect the MCP docs server** for easier doc access:
   ```
   claude mcp add --transport http nmiai https://mcp-docs.ainm.no/mcp
   ```

2. **Set up the project** — FastAPI skeleton, Tripletex client, Cloud Run deployment

3. **Explore the sandbox** — Get credentials, test every API endpoint, document findings

4. **Build the prompt parser** — Start with Claude API integration for structured extraction

5. **Implement Tier 1 handlers** — Simple CRUD operations first

6. **Submit and iterate** — Get on the leaderboard early, use feedback to improve
