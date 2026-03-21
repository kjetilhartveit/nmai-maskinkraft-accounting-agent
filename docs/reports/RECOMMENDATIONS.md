# Recommendations: Winning Strategy for the Tripletex Accounting Agent

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Our Agent (Hono/TypeScript)           │
│                                                         │
│  POST /solve                                            │
│    │                                                    │
│    ├─ 1. Prompt Parser (Gemini LLM)                     │
│    │     • Multilingual understanding (7 languages)     │
│    │     • Extract: task types, entities, field values   │
│    │     • Returns structured ParsedTaskSequence         │
│    │                                                    │
│    ├─ 2. Dependency Sort + Task Router                  │
│    │     • Sort tasks by dependency priority             │
│    │     • Map parsed task → dedicated handler or        │
│    │       generic agentic handler for unknown tasks     │
│    │                                                    │
│    ├─ 3. Task Handlers (per task type)                  │
│    │     • Deterministic API call sequences              │
│    │     • SequenceContext shares IDs between tasks      │
│    │     • Creates dependencies in correct order         │
│    │                                                    │
│    └─ 4. Tripletex API Client                           │
│          • Session token auth via proxy                  │
│          • Error handling + call logging                 │
│          • API call statistics tracking                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Why This Architecture?

**Hybrid approach: LLM for understanding + deterministic handlers for execution.**

- The LLM (Gemini) excels at understanding multilingual prompts and extracting structured data
- Deterministic handlers execute the exact right API calls — no trial-and-error
- The generic handler (LLM agentic loop) handles unknown/complex tasks that don't fit dedicated handlers
- SequenceContext eliminates redundant lookups in multi-task sequences

This gives us **correctness** (deterministic handlers) AND **efficiency** (minimal, pre-planned API calls with zero errors).

## Scoring & Priority

### Score Formula
```
task_score = correctness × tier_multiplier × (1 + efficiency_bonus)
```

Where:
- `correctness` ∈ [0, 1] — field-by-field checks
- `tier_multiplier` ∈ {1, 2, 3}
- `efficiency_bonus` ∈ [0, 1] — only when correctness = 1.0

### Priority

| Priority | Focus | Impact |
|----------|-------|--------|
| 1 | Eliminate total failures (task not completed) | Baseline |
| 2 | Fix wrong parameters (correctness → 1.0) | Field-by-field score |
| 3 | Cover all 30 task types | Breadth |
| 4 | Minimize API calls (efficiency bonus) | Bonus multiplier |

## Key Findings

### BETA Endpoints
Many endpoints marked `[BETA]` return 403 Forbidden in the competition sandbox. See AGENTS.md for the full list. The #1 source of errors in early submissions.

### Multi-language Parsing
Suppliers in foreign languages are frequently misclassified as "unknown" by the LLM. The system prompt includes multilingual keywords and explicit examples for common cases.

### Dependency Ordering
The `sortByDependency` function ensures correct execution order (departments → entities → orders/projects → invoices → payments). Unknown tasks run at the same priority as orders/projects (after entity creation).

### Context Sharing
SequenceContext tracks IDs for: customers, employees, departments, suppliers, products, orders, invoices. This eliminates redundant GET lookups in multi-step chains like create_customer → send_invoice → create_payment.

## Improvement Areas

### Current Weaknesses
1. **Generic handler efficiency** — uses 5-25 API calls vs 1-8 for dedicated handlers
2. **File attachment processing** — file contents are not sent to the LLM (only names/MIME types)
3. **Salary/payroll tasks** — generic handler often fails due to BETA endpoint restrictions
4. **Payment reversal** — complex multi-step task handled by generic handler

### Expansion Opportunities
- Add dedicated handlers for common "unknown" tasks (incoming invoices via vouchers, salary via vouchers)
- Process PDF/image file contents by passing to Gemini multimodal
- Add retry logic with exponential backoff for transient API errors
- Improve product number extraction from parenthesized notation in prompts
