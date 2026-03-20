# Evaluation framework design

This document describes how we structure automated evaluation for the NM i AI 2026 accounting agent: parsing quality, Tripletex API efficiency, end-to-end correctness, multi-language coverage, and comparing LLM / system-prompt setups without leaking context between runs.

## 1. Test cases: prompts and expected outcomes

Each **test case** bundles:

| Field | Role |
|--------|------|
| `id` | Stable identifier for reports and CI |
| `prompt` | Natural-language task (mirrors competition prompts) |
| `language` | Expected **detected** language (ISO-style code: `no`, `en`, `de`, …) |
| `tier` | Difficulty / scoring tier (1–3) for tier multipliers |
| `taskType` | Expected `ParsedTask.taskType` |
| `taskTypeAlternatives` | Optional acceptable aliases (e.g. `create_invoice` vs `send_invoice`) |
| `expectedEntities` | List of **partial** entity objects: each must match some parsed entity (field subset + value equality, case-insensitive strings) |
| `expectedApiCalls` | Optional bounds: `min` / `max` total HTTP calls, `maxErrors` (4xx+ counted as errors in the client) |
| `notes` | Human hints for ambiguous parses |

Cases live in `src/eval/test-cases.ts`, seeded from `docs/sample-tripletex-prompts.json` with expectations filled in by hand. As new handlers ship, expectations should be tightened (exact fields, tighter API bounds).

## 2. LLM parsing accuracy

We evaluate parsing **separately** from “did Tripletex succeed”:

- **Task type**: Must be in `{ taskType } ∪ taskTypeAlternatives`.
- **Language**: Normalized string equality with the case’s `language`.
- **Entities**: Each expected partial entity must be **injectable** into a distinct parsed entity (unique matching). Values tolerate string/number for numeric fields.

This matches how we score “understanding” before caring about sandbox side effects. Failed execution with a perfect parse still fails the **overall** success flag but remains visible via `parseMatch` vs `serverReportedSuccess` in the runner output.

## 3. API call efficiency

The Tripletex client records every HTTP call (`method`, `endpoint`, `status`, `durationMs`, `isError`).

Metrics:

- **Count**: Total calls per test case (listed in eval response `apiCallStats.total`).
- **Errors**: Responses with `status >= 400` (and network failures logged with `status: 0`), exposed as `apiCallStats.errors`.

Test cases may define `expectedApiCalls` ceilings so regressions (e.g. redundant list-then-create loops) fail the run. Competition **efficiency bonus** applies only when correctness is 100%; the same idea is reflected locally: we gate **success** on bounds only when `expectedApiCalls` is set.

## 4. Correctness of created / updated data

Full **state verification** (fetch entity from Tripletex and compare) is not yet wired in; the current framework focuses on:

1. **Parse correctness** (task + entities).
2. **Handler execution** without thrown errors (`serverReportedSuccess` from `/solve` in eval mode).

Next steps for stronger correctness checks (aligned with “field checks” in scoring):

- After success, `GET` relevant resources (employee, department, supplier, …) and assert on IDs/fields.
- Run against a **fresh empty sandbox** per batch (see below) and optionally assert “exactly one new row” via list filters.

## 5. Comparing models and system prompts without context pollution

Principles:

- **Fresh sandbox per real submission** (competition): no cross-task state.
- **Local eval**: `resetCaches()` runs at the start of each `/solve` when `X-Eval-Mode: true`, so module-level caches (e.g. default department) do not bleed between cases on a long-lived dev server.
- **Model / prompt selection** is passed **per request** via headers, not by mutating global config:
  - `X-Eval-Model`: OpenRouter model id.
  - `X-Eval-System-Prompt-Variant`: e.g. `default` | `minimal` (see `src/lib/llm.ts`).

That way parallel eval workers or sequential runs do not depend on a shared `OPENROUTER_MODEL` mutation.

## 6. Running evaluations at scale and aggregating results

Operational pattern:

1. Start the API (`pnpm dev` or `pnpm start`).
2. Run `pnpm eval` (or `pnpm eval -- --model … --system-prompt-variant …`).
3. Each case is one HTTP `POST /solve` with eval headers; results are `EvalResult[]`.
4. `summarize()` produces `EvalSummary` (counts, averages, API totals).

For scale:

- **Sharding**: Split `testCases` by `id` prefix or language and run multiple processes against separate sandboxes.
- **CI**: Run a subset on every PR (fast tier-1 cases), nightly full matrix (models × prompt variants × languages).
- **Artifacts**: Serialize `EvalResult[]` as JSON Lines for dashboards; join on `testCaseId` + `config`.

## 7. Scoring and comparing setups

**Competition formula (reference):**

\[
\text{score} = \text{correctness}_{\text{fields}} \times \text{tierMultiplier}(\text{tier}) \times \text{efficiencyBonus}
\]

- **Correctness**: Binary / weighted field checks on the *right* operations (the framework’s `parseMatch` + future field checks map to this).
- **Tier multiplier**: From case `tier` (1–3).
- **Efficiency bonus**: Applied **only if** correctness is 100%; rewards fewer API calls and **zero** client-recorded 4xx-style errors.

**Comparing setups** (local):

- For each `(model, systemPromptVariant)`, compute pass rate, mean `elapsedMs`, mean API count, total API errors.
- Prefer **higher pass rate**; break ties with **lower API count** and **lower latency**, consistent with the bonus philosophy.

## Multi-language coverage

The sample set spans several languages (`en`, `fr`, `pt`, `de`, `no`). The championship requires coverage across **seven** languages; extend `test-cases.ts` with additional prompts (e.g. Spanish, Nynorsk) using the same schema so all languages appear in the aggregate matrix.

## Implementation map

| Piece | Location |
|--------|-----------|
| Types | `src/eval/types.ts` |
| Cases | `src/eval/test-cases.ts` |
| Matching | `src/eval/match.ts` |
| Runner | `src/eval/runner.ts` |
| Console report | `src/eval/reporter.ts` |
| CLI | `pnpm eval` → `src/scripts/run-eval.ts` |
| Eval HTTP contract | `X-Eval-Mode` + optional model/variant headers in `src/routes/solve.ts` |

This keeps evaluation logic versioned beside the server while remaining safe for normal clients (default response remains `{ "status": "completed" }` without eval headers).
