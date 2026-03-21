#!/usr/bin/env tsx
/**
 * Task Analysis — Competition scoring and task type breakdown.
 *
 * Usage:
 *   pnpm analyze                         Overview of all task types with scores
 *   pnpm analyze -- --type <type>        Detailed view of a specific task type
 *   pnpm analyze -- --worst              Priority list of worst-performing types
 *   pnpm analyze -- --classify           Re-classify all solves using LLM
 *   pnpm analyze -- --classify-non-eval  Re-classify only non-eval solves using LLM
 *   pnpm analyze -- --classify-missing   Only classify solves without a type (LLM)
 */
import "dotenv/config";
import db from "../lib/db.js";
import { classifyPromptsBatch, classifyPromptRegex, detectLanguage } from "../lib/task-classifier.js";

interface SolveRow {
  id: string;
  prompt: string;
  source: string;
  success: number;
  api_call_errors: number;
  score_earned: number | null;
  score_max: number | null;
  checks_passed: number | null;
  checks_total: number | null;
  checks_detail: string | null;
  classified_type: string | null;
  elapsed_ms: number | null;
}

// ── Retroactive classification ──────────────────────────────────────

async function classifyMissingSolves(): Promise<number> {
  const solves = db
    .prepare("SELECT id, prompt FROM solves WHERE classified_type IS NULL")
    .all() as { id: string; prompt: string }[];

  if (solves.length === 0) return 0;

  console.log(`[Classifier] Classifying ${solves.length} unclassified solves via LLM...`);
  const { results } = await classifyPromptsBatch(solves, { concurrency: 10, verbose: true });

  const update = db.prepare("UPDATE solves SET classified_type = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const [id, type] of results) {
      update.run(type, id);
    }
  });
  tx();
  return results.size;
}

async function reclassifyAllSolves(): Promise<number> {
  const solves = db
    .prepare("SELECT id, prompt FROM solves")
    .all() as { id: string; prompt: string }[];

  console.log(`[Classifier] Re-classifying all ${solves.length} solves via LLM...`);
  const { results } = await classifyPromptsBatch(solves, { concurrency: 10, verbose: true });

  const update = db.prepare("UPDATE solves SET classified_type = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const [id, type] of results) {
      update.run(type, id);
    }
  });
  tx();
  return results.size;
}

async function reclassifyNonEvalSolves(): Promise<number> {
  const solves = db
    .prepare("SELECT id, prompt FROM solves WHERE source != 'eval'")
    .all() as { id: string; prompt: string }[];

  if (solves.length === 0) {
    console.log("[Classifier] No non-eval solves to classify.");
    return 0;
  }

  console.log(`[Classifier] Re-classifying ${solves.length} non-eval solves via LLM (no regex fallback)...`);
  const { results, stats } = await classifyPromptsBatch(solves, { concurrency: 10, verbose: true, llmOnly: true });

  const update = db.prepare("UPDATE solves SET classified_type = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const [id, type] of results) {
      update.run(type, id);
    }
  });
  tx();

  if (stats.skipped > 0) {
    console.log(`[Classifier] ${stats.skipped} prompts skipped (LLM failed) — their classified_type unchanged.`);
  }

  return results.size;
}

function reclassifyWithRegex(filter: "all" | "non-eval"): number {
  const query = filter === "non-eval"
    ? "SELECT id, prompt FROM solves WHERE source != 'eval'"
    : "SELECT id, prompt FROM solves";
  const solves = db.prepare(query).all() as { id: string; prompt: string }[];

  if (solves.length === 0) {
    console.log("[Classifier] No solves to classify.");
    return 0;
  }

  console.log(`[Classifier] Re-classifying ${solves.length} solves via regex...`);
  const update = db.prepare("UPDATE solves SET classified_type = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const solve of solves) {
      const type = classifyPromptRegex(solve.prompt);
      update.run(type, solve.id);
    }
  });
  tx();
  console.log(`[Classifier] Done — ${solves.length} solves classified via regex.`);
  return solves.length;
}

// ── Data loading ────────────────────────────────────────────────────

function loadScoredSolves(): SolveRow[] {
  return db
    .prepare(
      `SELECT id, prompt, source, success, api_call_errors,
              score_earned, score_max, checks_passed, checks_total,
              checks_detail, classified_type, elapsed_ms
       FROM solves WHERE checks_detail IS NOT NULL
       ORDER BY classified_type, source`,
    )
    .all() as SolveRow[];
}

interface TypeStats {
  count: number;
  scored: number;
  totalScore: number;
  perfect: number;
  zero: number;
  passedChecks: number;
  totalChecks: number;
  langs: Set<string>;
  failedCheckNames: Record<string, number>;
  examples: { prompt: string; checks: string; score: number | null; errors: number }[];
  avgMs: number;
  avgErrors: number;
}

function buildTypeStats(solves: SolveRow[]): Record<string, TypeStats> {
  const byType: Record<string, TypeStats> = {};

  for (const s of solves) {
    const type = s.classified_type || "unknown";
    if (!byType[type]) {
      byType[type] = {
        count: 0, scored: 0, totalScore: 0, perfect: 0, zero: 0,
        passedChecks: 0, totalChecks: 0, langs: new Set(),
        failedCheckNames: {}, examples: [], avgMs: 0, avgErrors: 0,
      };
    }
    const d = byType[type];
    d.count++;
    d.langs.add(detectLanguage(s.prompt));
    d.avgMs += s.elapsed_ms ?? 0;
    d.avgErrors += s.api_call_errors;

    if (s.checks_detail) {
      d.scored++;
      d.totalScore += s.score_earned ?? 0;

      try {
        const checks = JSON.parse(s.checks_detail) as (string | { name: string; passed: boolean })[];
        const passed = checks.filter(
          (c) => (typeof c === "string" && c.includes("passed")) || (typeof c === "object" && c.passed === true),
        ).length;
        d.passedChecks += passed;
        d.totalChecks += checks.length;

        if (passed === checks.length && checks.length > 0) d.perfect++;
        if (passed === 0 && checks.length > 0) d.zero++;

        const failures = checks.filter(
          (c) => (typeof c === "string" && c.includes("failed")) || (typeof c === "object" && c.passed === false),
        );
        for (const f of failures) {
          const name = typeof f === "string" ? f : f.name;
          d.failedCheckNames[name] = (d.failedCheckNames[name] || 0) + 1;
        }
        if (failures.length > 0 && d.examples.length < 2) {
          d.examples.push({
            prompt: s.prompt.slice(0, 120),
            checks: s.checks_detail,
            score: s.score_earned,
            errors: s.api_call_errors,
          });
        }
      } catch { /* ignore */ }
    }
  }

  for (const d of Object.values(byType)) {
    if (d.count > 0) {
      d.avgMs = Math.round(d.avgMs / d.count);
      d.avgErrors = Math.round((d.avgErrors / d.count) * 10) / 10;
    }
  }

  return byType;
}

// ── Display functions ───────────────────────────────────────────────

function showOverview(byType: Record<string, TypeStats>): void {
  const sorted = Object.entries(byType)
    .filter(([type]) => type !== "unknown")
    .sort((a, b) => b[1].count - a[1].count);

  console.log("");
  console.log("═".repeat(105));
  console.log("  COMPETITION TASK TYPE ANALYSIS");
  console.log("═".repeat(105));
  console.log("");

  const header =
    "Task Type".padEnd(28) +
    "Count".padStart(6) +
    "Scored".padStart(8) +
    "  Checks".padStart(10) +
    "  Perfect".padStart(9) +
    "  Zero".padStart(7) +
    "  Score".padStart(9) +
    "  AvgErr".padStart(8) +
    "  Langs";
  console.log(header);
  console.log("─".repeat(105));

  let totalCount = 0;
  let totalScored = 0;
  let totalPerfect = 0;
  let totalZero = 0;
  let totalScore = 0;

  for (const [type, d] of sorted) {
    totalCount += d.count;
    totalScored += d.scored;
    totalPerfect += d.perfect;
    totalZero += d.zero;
    totalScore += d.totalScore;

    const checkStr = d.totalChecks > 0
      ? `${d.passedChecks}/${d.totalChecks} ${(d.passedChecks / d.totalChecks * 100).toFixed(0)}%`
      : "-";
    const perfectStr = `${d.perfect}/${d.scored}`;
    const zeroStr = `${d.zero}/${d.scored}`;
    const langs = [...d.langs].sort().join(",");
    const scoreStr = d.totalScore.toFixed(1);

    console.log(
      type.padEnd(28) +
      String(d.count).padStart(6) +
      String(d.scored).padStart(8) +
      checkStr.padStart(12) +
      perfectStr.padStart(9) +
      zeroStr.padStart(7) +
      scoreStr.padStart(9) +
      String(d.avgErrors).padStart(8) +
      "  " + langs,
    );
  }

  if (byType["unknown"]?.count) {
    const d = byType["unknown"];
    console.log(
      "unknown".padEnd(28) +
      String(d.count).padStart(6) +
      String(d.scored).padStart(8) +
      "-".padStart(12) +
      "-".padStart(9) +
      "-".padStart(7) +
      "-".padStart(9) +
      String(d.avgErrors).padStart(8),
    );
    totalCount += d.count;
    totalScored += d.scored;
  }

  console.log("─".repeat(105));
  console.log(
    "TOTAL".padEnd(28) +
    String(totalCount).padStart(6) +
    String(totalScored).padStart(8) +
    "".padStart(12) +
    `${totalPerfect}/${totalScored}`.padStart(9) +
    `${totalZero}/${totalScored}`.padStart(7) +
    totalScore.toFixed(1).padStart(9),
  );
  console.log("");
}

function showWorst(byType: Record<string, TypeStats>): void {
  console.log("");
  console.log("═".repeat(90));
  console.log("  WORST PERFORMING TASK TYPES (by failed checks)");
  console.log("═".repeat(90));

  const withFailures = Object.entries(byType)
    .filter(([, d]) => Object.keys(d.failedCheckNames).length > 0)
    .sort((a, b) => {
      const aFails = Object.values(a[1].failedCheckNames).reduce((s, v) => s + v, 0);
      const bFails = Object.values(b[1].failedCheckNames).reduce((s, v) => s + v, 0);
      return bFails - aFails;
    });

  for (const [type, d] of withFailures) {
    const totalFails = Object.values(d.failedCheckNames).reduce((s, v) => s + v, 0);
    const pct = d.totalChecks > 0 ? (d.passedChecks / d.totalChecks * 100).toFixed(0) : "0";

    console.log(`\n  ${type} — ${totalFails} failed checks, ${pct}% pass rate, ${d.perfect}/${d.scored} perfect`);

    const sortedChecks = Object.entries(d.failedCheckNames).sort((a, b) => b[1] - a[1]);
    for (const [check, count] of sortedChecks) {
      console.log(`    ${check}: ${count}x`);
    }

    if (d.examples.length > 0) {
      const ex = d.examples[0];
      console.log(`    Example: score=${ex.score} err=${ex.errors} | ${ex.prompt}`);
    }
  }
  console.log("");
}

function showTypeDetail(byType: Record<string, TypeStats>, targetType: string): void {
  const d = byType[targetType];
  if (!d) {
    console.error(`Task type "${targetType}" not found.`);
    console.log("Available types:", Object.keys(byType).sort().join(", "));
    return;
  }

  console.log(`\n  ${targetType}`);
  console.log("─".repeat(60));
  console.log(`  Count:       ${d.count} (${d.scored} scored)`);
  console.log(`  Score:       ${d.totalScore.toFixed(2)} total`);
  console.log(`  Checks:      ${d.passedChecks}/${d.totalChecks} (${d.totalChecks > 0 ? (d.passedChecks / d.totalChecks * 100).toFixed(0) : 0}%)`);
  console.log(`  Perfect:     ${d.perfect}/${d.scored}`);
  console.log(`  Zero:        ${d.zero}/${d.scored}`);
  console.log(`  Languages:   ${[...d.langs].sort().join(", ")}`);
  console.log(`  Avg errors:  ${d.avgErrors}`);
  console.log(`  Avg time:    ${(d.avgMs / 1000).toFixed(1)}s`);

  if (Object.keys(d.failedCheckNames).length > 0) {
    console.log("\n  Failed checks:");
    const sorted = Object.entries(d.failedCheckNames).sort((a, b) => b[1] - a[1]);
    for (const [check, count] of sorted) {
      console.log(`    ${check}: ${count}x`);
    }
  }

  // Show individual prompts
  const solves = db
    .prepare(
      `SELECT prompt, score_earned, checks_passed, checks_total, checks_detail, api_call_errors, source
       FROM solves WHERE classified_type = ? AND checks_detail IS NOT NULL
       ORDER BY score_earned DESC NULLS LAST`,
    )
    .all(targetType) as {
    prompt: string; score_earned: number | null; checks_passed: number | null;
    checks_total: number | null; checks_detail: string | null;
    api_call_errors: number; source: string;
  }[];

  if (solves.length > 0) {
    console.log(`\n  All scored instances (${solves.length}):`);
    for (const s of solves) {
      const score = s.score_earned !== null ? s.score_earned.toFixed(2) : "-";
      const checks = s.checks_passed !== null ? `${s.checks_passed}/${s.checks_total}` : "-";
      const lang = detectLanguage(s.prompt);
      console.log(`    [${lang}] score=${score} checks=${checks} err=${s.api_call_errors} src=${s.source}`);
      console.log(`         ${s.prompt.slice(0, 120)}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Task Analysis — Competition scoring and task type breakdown

Usage:
  pnpm analyze                              Overview of all task types with scores
  pnpm analyze -- --type <type>             Detailed view of a specific task type
  pnpm analyze -- --worst                   Priority list of worst-performing types
  pnpm analyze -- --classify                Re-classify ALL solves using LLM
  pnpm analyze -- --classify-non-eval       Re-classify only non-eval solves using LLM
  pnpm analyze -- --classify-missing        Classify only unclassified solves using LLM
`);
    return;
  }

  if (args.includes("--classify-regex")) {
    const scope = args.includes("--non-eval") ? "non-eval" as const : "all" as const;
    const count = reclassifyWithRegex(scope);
    console.log(`Re-classified ${count} solves via regex.\n`);
  } else if (args.includes("--classify")) {
    const count = await reclassifyAllSolves();
    console.log(`Re-classified ${count} solves via LLM.\n`);
  } else if (args.includes("--classify-non-eval")) {
    const count = await reclassifyNonEvalSolves();
    console.log(`Re-classified ${count} non-eval solves via LLM.\n`);
  } else if (args.includes("--classify-missing")) {
    const count = await classifyMissingSolves();
    console.log(`Classified ${count} new solves via LLM.\n`);
  }

  const solves = loadScoredSolves();
  const byType = buildTypeStats(solves);

  if (args.includes("--type") || args.includes("-t")) {
    const idx = args.indexOf("--type") !== -1 ? args.indexOf("--type") : args.indexOf("-t");
    const targetType = args[idx + 1];
    if (!targetType) {
      console.error("Usage: pnpm analyze -- --type <task_type>");
      return;
    }
    showTypeDetail(byType, targetType);
    return;
  }

  if (args.includes("--worst") || args.includes("-w")) {
    showWorst(byType);
    return;
  }

  showOverview(byType);
  console.log("Use --worst to see failure details, --type <type> for per-type deep dive.");
  console.log("Use --classify to re-classify all solves via LLM, or --classify-missing for new ones only.");
}

main().catch(console.error);
