# Fix complex competition tasks

8 complex competition prompts are failing or producing excessive API errors. Root cause analysis shows two distinct problems:

## Problem 1: Parser Misclassification (5 tasks, ~60 competition points at risk)

The LLM parser routes tasks to `unknown` (generic handler) when dedicated handlers exist:

| Prompt | Parsed as | Should be | Calls/Errs | Optimal |
|--------|-----------|-----------|------------|---------|
| Supplier invoice (Ridgepoint, EN) | `unknown` | `create_supplier` + `create_supplier_invoice` | 30/17 | 5/0 |
| Payroll (Emily Lewis, EN) | `unknown` | `create_payroll` | 29/11 | 6/0 |
| Dimension (Prosjekttype, NN) | `unknown` | `create_dimension` | 12/5 | 7/0 |
| Payment (Estrela Lda, PT) | `create_invoice`+`create_payment` | `create_payment` only | 31/16 | 5/0 |
| Dimension (Region, ES) | `create_department`+`create_voucher` | `create_dimension` | 3/1 | 7/0 |

**Impact**: Fixing parsing alone would eliminate ~50 API errors and ~85 unnecessary calls across these 5 tasks.

### Root cause
The system prompt has examples and keywords but the LLM still misclassifies when:
- The prompt uses slightly different phrasing (e.g., "Register the supplier invoice" vs "received invoice from supplier")
- The prompt is in a language where keyword matching fails (e.g., NN "rekneskapsdimensjon")
- The prompt contains "fatura pendente" but the LLM creates a new invoice instead of finding the existing one

### Fix: Post-parse classifier guard
Add a deterministic post-processing step after LLM parsing that catches common misclassifications:
1. If parsed as `unknown` but prompt contains supplier invoice keywords → reclassify
2. If parsed as `unknown` but prompt contains payroll keywords → reclassify
3. If parsed as `unknown` but prompt contains dimension keywords → reclassify
4. If parsed as `create_invoice` + `create_payment` but prompt says "pending/outstanding invoice" → remove `create_invoice`
5. If parsed as `create_department` but prompt says "dimension" → reclassify to `create_dimension`

## Problem 2: Complex Analytical Tasks (3 tasks, need better generic handler recipes)

| Prompt | Description | Calls/Errs | Target |
|--------|-------------|------------|--------|
| Annual closing (ES) | 3 depreciations + prepaid reversal + tax provision | 26/0 | 20/0 |
| Currency disagio (PT) | EUR invoice, payment at different rate, book exchange loss | 12/4 | 10/0 |
| Ledger analysis (DE) | Read ledger, find top 3 expense increases, create projects + activities | 19/5 | 15/0 |
| Bank reconciliation (PT/NO) | CSV matching with invoices, partial payments | 17/7 | hard |

### Fix: Add recipes to generic handler
Add explicit recipes for these analytical patterns so the LLM has exact instructions.

## Plan

- [x] Analyze competition database for failure patterns
- [x] Add test cases for all 8 complex tasks to `promoted-test-cases.json`
- [x] Add deterministic post-parse classifier guard in `src/lib/llm.ts`
- [x] Add 4 new examples to LLM system prompt (examples 12-14 for competition patterns)
- [x] Fix misleading "use unknown for dimensions" instruction in system prompt
- [x] Add generic handler recipes for annual closing, disagio, ledger analysis, bank reconciliation
- [ ] Verify fixes with eval: `pnpm eval -- --task-type create_payroll --one-per-type`
- [ ] Verify fixes with eval: `pnpm eval -- --task-type create_supplier_invoice --one-per-type`
- [ ] Verify fixes with eval: `pnpm eval -- --task-type create_dimension --one-per-type`
- [ ] Verify fixes with eval: `pnpm eval -- --task-type create_payment --one-per-type`
- [ ] Run full eval: `pnpm eval -- --one-per-type`

### Execution of plan

- Work in the current branch
- Git commit after each major change
- After every step tick it off and commit
