import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "../lib/config.js";
import { testCases } from "../eval/test-cases.js";
import { runEval, summarize } from "../eval/runner.js";
import { printEvalTable, findBaselineImprovements, printBaselineImprovements } from "../eval/reporter.js";
import { pickOnePerTaskType, getTopFailingTaskTypes } from "../eval/task-type-analysis.js";
import type { EvalConfig } from "../eval/types.js";

const TEST_CASES_FILE = join(import.meta.dirname, "../eval/test-cases.ts");

function parseArgs(argv: string[]): {
  model?: string;
  systemPromptVariant?: string;
  description?: string;
  serverUrl?: string;
  iterations?: number;
  filter?: string;
  tier?: number[];
  taskType?: string;
  onePerType?: boolean;
  worst?: number;
  updateBaselines?: boolean;
} {
  const out: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) {
      out.model = argv[++i];
    } else if (a === "--system-prompt-variant" && argv[i + 1]) {
      out.systemPromptVariant = argv[++i];
    } else if (a === "--description" && argv[i + 1]) {
      out.description = argv[++i];
    } else if (a === "--server" && argv[i + 1]) {
      out.serverUrl = argv[++i];
    } else if (a === "--iterations" && argv[i + 1]) {
      out.iterations = parseInt(argv[++i], 10);
    } else if (a === "--filter" && argv[i + 1]) {
      out.filter = argv[++i];
    } else if (a === "--tier" && argv[i + 1]) {
      out.tier = argv[++i].split(",").map(Number);
    } else if (a === "--task-type" && argv[i + 1]) {
      out.taskType = argv[++i];
    } else if (a === "--one-per-type") {
      out.onePerType = true;
    } else if (a === "--worst") {
      out.worst = argv[i + 1] && !argv[i + 1].startsWith("--") ? parseInt(argv[++i], 10) : 5;
    } else if (a === "--update-baselines") {
      out.updateBaselines = true;
    }
  }
  return out;
}

function applyBaselineUpdates(improvements: { testCaseId: string; newMax: number }[]): void {
  let content = readFileSync(TEST_CASES_FILE, "utf-8");

  for (const imp of improvements) {
    const idPattern = new RegExp(
      `(id:\\s*"${imp.testCaseId}"[\\s\\S]*?expectedApiCalls:\\s*\\{[^}]*max:\\s*)\\d+`,
    );
    const match = content.match(idPattern);
    if (match) {
      content = content.replace(idPattern, `$1${imp.newMax}`);
      console.log(`  Updated ${imp.testCaseId}: max → ${imp.newMax}`);
    } else {
      console.warn(`  Could not find expectedApiCalls.max for ${imp.testCaseId}`);
    }
  }

  writeFileSync(TEST_CASES_FILE, content);
  console.log(`\nWrote updated baselines to ${TEST_CASES_FILE}`);
}

async function main() {
  const argv = process.argv.slice(2).filter((x) => x !== "--");
  const args = parseArgs(argv);

  const evalConfig: EvalConfig = {
    model: args.model ?? config.google.model,
    ...(args.systemPromptVariant
      ? { systemPromptVariant: args.systemPromptVariant }
      : {}),
    ...(args.description ? { description: args.description } : {}),
  };

  let cases = testCases;
  if (args.tier) {
    cases = cases.filter((tc) => args.tier!.includes(tc.tier));
  }
  if (args.taskType) {
    cases = cases.filter(
      (tc) =>
        tc.taskType === args.taskType ||
        tc.taskTypeAlternatives?.includes(args.taskType! as any),
    );
  }
  if (args.filter) {
    cases = cases.filter(
      (tc) =>
        tc.id.includes(args.filter!) ||
        tc.taskType.includes(args.filter!) ||
        tc.prompt.toLowerCase().includes(args.filter!.toLowerCase()),
    );
  }
  if (args.worst) {
    const topFailing = getTopFailingTaskTypes(args.worst);
    const failingTypes = new Set(topFailing.map((t) => t.taskType.split(" > ")[0]));
    cases = cases.filter(
      (tc) => failingTypes.has(tc.taskType) || tc.taskTypeAlternatives?.some((a) => failingTypes.has(a)),
    );
    console.log(`Top ${args.worst} failing task types from solve history:`);
    for (const t of topFailing) {
      const bar = t.successRate >= 80 ? "\x1b[32m" : t.successRate >= 50 ? "\x1b[33m" : "\x1b[31m";
      console.log(`  ${bar}${t.successRate.toString().padStart(3)}%\x1b[0m  ${t.taskType}  (${t.passed}/${t.total})${t.lastError ? `  └─ ${t.lastError.slice(0, 80)}` : ""}`);
    }
    console.log("");
  }
  if (args.onePerType) {
    cases = pickOnePerTaskType(cases);
  }

  if (cases.length === 0) {
    console.error("No test cases match the given filters.");
    process.exit(1);
  }

  const iterations = args.iterations ?? 1;
  const serverUrl = args.serverUrl ?? process.env.SERVER_URL ?? "http://localhost:3000";

  const labels: string[] = [];
  if (args.tier) labels.push(`tier ${args.tier.join(",")}`);
  if (args.taskType) labels.push(`task-type: ${args.taskType}`);
  if (args.onePerType) labels.push("one-per-type");
  if (args.worst) labels.push(`worst ${args.worst}`);
  const filterLabel = labels.length > 0 ? ` (${labels.join(", ")})` : "";
  console.log(`Evaluating ${cases.length} case(s) × ${iterations} iteration(s)${filterLabel} (server: ${serverUrl})`);
  console.log(`Model: ${evalConfig.model}${evalConfig.systemPromptVariant ? ` | system prompt variant: ${evalConfig.systemPromptVariant}` : ""}\n`);

  const results = await runEval(evalConfig, cases, {
    serverUrl: args.serverUrl,
    iterations,
    onResult: (r, idx, total) => {
      const icon = r.success ? "\x1b[32m PASS \x1b[0m" : "\x1b[31m FAIL \x1b[0m";
      const api = `${r.apiCalls.count} calls${r.apiCalls.errors > 0 ? ` (${r.apiCalls.errors} err)` : ""}`;
      const time = `${(r.elapsedMs / 1000).toFixed(1)}s`;
      console.log(`[${idx}/${total}] ${icon} ${r.testCaseId}  ${api}  ${time}`);
      if (r.error && !r.success) {
        console.log(`         └─ ${r.error.slice(0, 120)}`);
      }
    },
  });
  const summary = summarize(results);
  console.log("");
  printEvalTable(results, summary);

  const improvements = findBaselineImprovements(results, cases);
  if (improvements.length > 0) {
    if (args.updateBaselines) {
      console.log(`\nApplying ${improvements.length} baseline improvement(s)...`);
      applyBaselineUpdates(improvements);
    } else {
      printBaselineImprovements(improvements);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
