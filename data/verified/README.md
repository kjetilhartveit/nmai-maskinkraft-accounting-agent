# Verified Test Data

This directory contains human-verified ground truth for evaluation.

## Structure

- `answers.json` — Verified answers for test cases (expected task type, entities, optimal API calls)
- `../captures/runs.jsonl` — Raw capture data from agent runs (for review and verification)

## Workflow

1. Run `pnpm capture "prompt text"` to capture a run's full output
2. Review the captured data in `data/captures/runs.jsonl`
3. Add verified correct answers to `answers.json`
4. The eval framework uses test cases from `src/eval/test-cases.ts` which should align with verified answers
