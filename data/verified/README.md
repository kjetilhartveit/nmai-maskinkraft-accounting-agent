# Verified Test Data

This directory contains verified ground truth for evaluation.

## Structure

- `promoted-test-cases.json` — Verified test cases for the eval suite
- `answers.json` — Verified answers for test cases (expected task type, entities, optimal API calls)

## Workflow

1. Test cases are defined in `src/eval/test-cases.ts` (manual) and `promoted-test-cases.json` (verified)
2. Run `pnpm eval` to test all cases against the sandbox
3. Review results in `data/agent.db` (solves table)
4. Use `pnpm probe` to quickly validate endpoint behavior before changing handlers

## Key error patterns (tracked)

- Customer `postalAddress` type error → handler retries without address on 422
- Product `vatType` rejection in sandbox → handler retries without `vatType` field (sandbox VAT codes may be restricted)
- Travel expense cost `description` vs `comments` → fixed (API field is `comments`)
- Payroll via salary API → dedicated `create_payroll` handler uses voucher (salary endpoints return 403)
- Supplier invoices via incoming invoice API → dedicated `create_supplier_invoice` handler uses voucher (incoming invoice endpoints return 403)
- Custom dimensions + voucher → dedicated `create_dimension` handler links dimension values to voucher postings via `freeAccountingDimensionN`
- Payroll LLM misclassification → system prompt strengthened to always use `create_payroll` even when prompt mentions fallback strategies
