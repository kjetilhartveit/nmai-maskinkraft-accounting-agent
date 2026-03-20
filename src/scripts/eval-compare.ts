import "dotenv/config";
import { config } from "../lib/config.js";
import { testCases } from "../eval/test-cases.js";
import { runEval, summarize } from "../eval/runner.js";
import { printEvalTable } from "../eval/reporter.js";
import type { EvalConfig, EvalSummary } from "../eval/types.js";

/**
 * Runs multiple eval configurations side-by-side and prints a comparison.
 *
 * Usage:
 *   pnpm eval:compare
 *   pnpm eval:compare --iterations 3
 *   pnpm eval:compare --filter dept
 */

function parseArgs(argv: string[]) {
  const out: { iterations: number; filter?: string; serverUrl?: string } = {
    iterations: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--iterations" && argv[i + 1]) {
      out.iterations = parseInt(argv[++i], 10);
    } else if (a === "--filter" && argv[i + 1]) {
      out.filter = argv[++i];
    } else if (a === "--server" && argv[i + 1]) {
      out.serverUrl = argv[++i];
    }
  }
  return out;
}

const CONFIGS_TO_COMPARE: EvalConfig[] = [
  {
    model: "anthropic/claude-sonnet-4.6",
    systemPromptVariant: "default",
    description: "Claude Sonnet (default prompt)",
  },
  {
    model: "anthropic/claude-sonnet-4.6",
    systemPromptVariant: "minimal",
    description: "Claude Sonnet (minimal prompt)",
  },
  {
    model: "google/gemini-2.5-flash-preview",
    systemPromptVariant: "default",
    description: "Gemini Flash (default prompt)",
  },
];

function printComparison(summaries: EvalSummary[]) {
  console.log("\n" + "=".repeat(80));
  console.log("COMPARISON SUMMARY");
  console.log("=".repeat(80));

  const colLabel = 40;
  const colPass = 12;
  const colApi = 12;
  const colErr = 10;
  const colMs = 10;

  function pad(s: string, w: number): string {
    return s.length >= w ? s.slice(0, w - 1) + "…" : s + " ".repeat(w - s.length);
  }

  const header = `${pad("Config", colLabel)} ${pad("Pass Rate", colPass)} ${pad("API Calls", colApi)} ${pad("Errors", colErr)} ${pad("Avg ms", colMs)}`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const s of summaries) {
    const label = s.config.description ?? s.config.model;
    const passRate = `${s.passed}/${s.totalCases} (${Math.round((s.passed / s.totalCases) * 100)}%)`;
    const line = `${pad(label, colLabel)} ${pad(passRate, colPass)} ${pad(String(s.totalApiCalls), colApi)} ${pad(String(s.totalApiErrors), colErr)} ${pad(String(s.avgElapsedMs), colMs)}`;
    console.log(line);
  }

  console.log("-".repeat(header.length));

  const best = summaries.reduce((a, b) => {
    if (b.passed > a.passed) return b;
    if (b.passed === a.passed && b.totalApiCalls < a.totalApiCalls) return b;
    if (b.passed === a.passed && b.totalApiCalls === a.totalApiCalls && b.avgElapsedMs < a.avgElapsedMs) return b;
    return a;
  });
  const bestLabel = best.config.description ?? best.config.model;
  console.log(`Best config: ${bestLabel} (${best.passed}/${best.totalCases} passed, ${best.totalApiCalls} API calls, avg ${best.avgElapsedMs}ms)`);
}

async function main() {
  const argv = process.argv.slice(2).filter((x) => x !== "--");
  const args = parseArgs(argv);

  let cases = testCases;
  if (args.filter) {
    cases = cases.filter(
      (tc) =>
        tc.id.includes(args.filter!) ||
        tc.taskType.includes(args.filter!) ||
        tc.prompt.toLowerCase().includes(args.filter!.toLowerCase()),
    );
  }

  const serverUrl = args.serverUrl ?? process.env.SERVER_URL ?? "http://localhost:3000";
  const iterations = args.iterations;

  console.log(`Comparing ${CONFIGS_TO_COMPARE.length} configs × ${cases.length} cases × ${iterations} iteration(s)`);
  console.log(`Server: ${serverUrl}\n`);

  const summaries: EvalSummary[] = [];

  for (const evalConfig of CONFIGS_TO_COMPARE) {
    const label = evalConfig.description ?? evalConfig.model;
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Running: ${label}`);
    console.log(`${"─".repeat(60)}`);

    const results = await runEval(evalConfig, cases, {
      serverUrl,
      iterations,
    });
    const summary = summarize(results);
    printEvalTable(results, summary);
    summaries.push(summary);
  }

  printComparison(summaries);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
