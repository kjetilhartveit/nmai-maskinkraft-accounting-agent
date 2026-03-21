#!/usr/bin/env tsx
/**
 * Score Manager - View and update competition solve scores
 *
 * Usage:
 *   pnpm score-manager                           # List recent competition solves
 *   pnpm score-manager --update <id> <earned>/<max>  # Update score (e.g., 8/10)
 *   pnpm score-manager --summary                 # Show scoring summary
 */
import "dotenv/config";
import {
  getRecentCompetitionSolves,
  updateScore,
} from "../lib/solve-logger.js";
import db from "../lib/db.js";
import { collectScores } from "../lib/score-collector.js";

function formatPrompt(prompt: string, maxLen = 50): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  return clean.length > maxLen ? clean.slice(0, maxLen - 3) + "..." : clean;
}

function listRecentSolves(limit = 20): void {
  const solves = db
    .prepare(
      `SELECT id, timestamp, prompt, score_earned, score_max,
              checks_passed, checks_total, checks_detail,
              success, api_call_errors
       FROM solves WHERE source = 'competition' ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(limit) as {
    id: string; timestamp: string; prompt: string;
    score_earned: number | null; score_max: number | null;
    checks_passed: number | null; checks_total: number | null;
    checks_detail: string | null;
    success: number; api_call_errors: number;
  }[];

  if (solves.length === 0) {
    console.log("No competition solves found.");
    return;
  }

  console.log("\n  Recent Competition Solves");
  console.log("─".repeat(100));
  console.log(
    "ID".padEnd(22) + "Score".padStart(8) + "Checks".padStart(10) +
    "Err".padStart(5) + "  " + "Prompt".padEnd(50),
  );
  console.log("─".repeat(100));

  for (const s of solves) {
    const id = s.id.slice(0, 20).padEnd(22);
    const score = s.score_earned !== null
      ? s.score_earned.toFixed(2).padStart(8)
      : "       -";
    const checks = s.checks_passed !== null && s.checks_total !== null
      ? `${s.checks_passed}/${s.checks_total}`.padStart(10)
      : "         -";
    const errors = String(s.api_call_errors).padStart(5);
    const prompt = formatPrompt(s.prompt, 48);

    console.log(`${id}${score}${checks}${errors}  ${prompt}`);

    if (s.checks_detail) {
      try {
        const detail = JSON.parse(s.checks_detail) as (string | { name: string; passed: boolean })[];
        const failedChecks = detail.filter((c) =>
          (typeof c === "string" && c.includes("failed")) ||
          (typeof c === "object" && c.passed === false),
        );
        if (failedChecks.length > 0) {
          const names = failedChecks.map((c) => typeof c === "string" ? c : c.name).join(", ");
          console.log(`${"".padEnd(22)}  FAILED: ${names}`);
        }
      } catch { /* ignore */ }
    }
  }

  console.log("─".repeat(100));
  console.log("\nTo auto-collect scores: pnpm collect-scores");
}

function showSummary(): void {
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
         SUM(CASE WHEN score_earned IS NOT NULL THEN 1 ELSE 0 END) as scored,
         SUM(COALESCE(score_earned, 0)) as total_earned,
         SUM(COALESCE(score_max, 0)) as total_max,
         AVG(api_call_errors) as avg_errors
       FROM solves WHERE source = 'competition'`,
    )
    .get() as {
    total: number;
    successful: number;
    scored: number;
    total_earned: number;
    total_max: number;
    avg_errors: number;
  };

  const pct = stats.total_max > 0
    ? ((stats.total_earned / stats.total_max) * 100).toFixed(1)
    : "0.0";

  console.log("\n╔════════════════════════════════════════════╗");
  console.log("║        Competition Scoring Summary          ║");
  console.log("╠════════════════════════════════════════════╣");
  console.log(`║  Total solves:           ${String(stats.total).padStart(10)}      ║`);
  console.log(`║  Successful:             ${String(stats.successful).padStart(10)}      ║`);
  console.log(`║  With scores entered:    ${String(stats.scored).padStart(10)}      ║`);
  console.log(`║  Total score:       ${String(stats.total_earned).padStart(5)}/${String(stats.total_max).padEnd(5)} (${pct}%)  ║`);
  console.log(`║  Avg API errors/solve:   ${stats.avg_errors.toFixed(1).padStart(10)}      ║`);
  console.log("╚════════════════════════════════════════════╝");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Score Manager - Track competition scores

Usage:
  pnpm score-manager                              List recent competition solves
  pnpm score-manager --summary                    Show scoring summary
  pnpm score-manager --collect                    Auto-collect scores from API then show
  pnpm score-manager --update <id> <earned>/<max> Update score from leaderboard
`);
    return;
  }

  if (args.includes("--collect")) {
    const updated = await collectScores({ verbose: true });
    console.log(`Collected ${updated} new scores.\n`);
  }

  if (args.includes("--summary")) {
    showSummary();
    return;
  }

  if (args.includes("--update")) {
    const idx = args.indexOf("--update");
    const solveId = args[idx + 1];
    const scoreStr = args[idx + 2];

    if (!solveId || !scoreStr || !scoreStr.includes("/")) {
      console.error("Usage: pnpm score-manager --update <solve-id> <earned>/<max>");
      console.error("Example: pnpm score-manager --update solve-1711234567890 8/10");
      process.exit(1);
    }

    const [earnedStr, maxStr] = scoreStr.split("/");
    const earned = parseFloat(earnedStr);
    const max = parseFloat(maxStr);

    if (isNaN(earned) || isNaN(max)) {
      console.error("Invalid score format. Use: <earned>/<max> (e.g., 8/10)");
      process.exit(1);
    }

    if (updateScore(solveId, earned, max)) {
      console.log(`Updated ${solveId}: ${earned}/${max}`);
    } else {
      console.error(`Failed to update score for ${solveId}`);
      process.exit(1);
    }
    return;
  }

  // Default: list recent solves
  const limit = parseInt(args[0], 10) || 20;
  listRecentSolves(limit);
}

main().catch(console.error);
