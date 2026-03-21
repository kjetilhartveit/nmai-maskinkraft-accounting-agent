import "dotenv/config";
import { testCases } from "../eval/test-cases.js";
import {
  getTopFailingTaskTypes,
  getVariationsForTaskType,
  getDistinctTaskTypes,
  pickOnePerTaskType,
} from "../eval/task-type-analysis.js";

const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[31m";
const B = "\x1b[34m";
const D = "\x1b[2m";
const X = "\x1b[0m";
const BOLD = "\x1b[1m";

function parseArgs(argv: string[]): { taskType?: string; worst?: boolean; variations?: boolean } {
  const out: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--type" && argv[i + 1]) out.taskType = argv[++i];
    else if (a === "--worst") out.worst = true;
    else if (a === "--variations") out.variations = true;
    else if (!a.startsWith("--")) out.taskType = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2).filter((x) => x !== "--"));
  const allTypes = getDistinctTaskTypes(testCases);

  if (args.taskType) {
    showTaskTypeDetail(args.taskType);
  } else if (args.worst) {
    showWorstTaskTypes();
  } else {
    showOverview(allTypes);
  }
}

function showOverview(allTypes: string[]) {
  console.log(`${BOLD}Task Type Overview${X}  (${testCases.length} total test cases)\n`);

  const byType = new Map<string, typeof testCases>();
  for (const tc of testCases) {
    if (!byType.has(tc.taskType)) byType.set(tc.taskType, []);
    byType.get(tc.taskType)!.push(tc);
  }

  console.log(`${"Task Type".padEnd(28)} ${"Cases".padStart(5)}  ${"T1".padStart(3)} ${"T2".padStart(3)} ${"T3".padStart(3)}  Languages`);
  console.log("-".repeat(80));

  for (const type of allTypes) {
    const cases = byType.get(type) ?? [];
    const t1 = cases.filter((c) => c.tier === 1).length;
    const t2 = cases.filter((c) => c.tier === 2).length;
    const t3 = cases.filter((c) => c.tier === 3).length;
    const langs = [...new Set(cases.map((c) => c.language))].sort().join(", ");
    console.log(
      `${B}${type.padEnd(28)}${X} ${String(cases.length).padStart(5)}  ${D}${String(t1).padStart(3)} ${String(t2).padStart(3)} ${String(t3).padStart(3)}${X}  ${langs}`,
    );
  }

  const picked = pickOnePerTaskType(testCases);
  console.log(`\n${D}Quick eval command: pnpm eval -- --one-per-type  (${picked.length} cases, one per type)${X}`);
  console.log(`${D}Worst failures:     pnpm eval -- --worst          (top 5 failing types from DB)${X}`);
  console.log(`${D}Single type:        pnpm eval -- --task-type create_invoice${X}`);
  console.log(`${D}Type detail:        pnpm task-types -- create_invoice${X}`);
}

function showTaskTypeDetail(taskType: string) {
  const { byLanguage, total } = getVariationsForTaskType(taskType, testCases);
  console.log(`${BOLD}${taskType}${X}  — ${total} test case(s)\n`);

  if (total === 0) {
    console.log(`${R}No test cases found for task type "${taskType}"${X}`);
    console.log(`\nAvailable types: ${getDistinctTaskTypes(testCases).join(", ")}`);
    return;
  }

  for (const [lang, variations] of Object.entries(byLanguage).sort()) {
    console.log(`  ${BOLD}${lang.toUpperCase()}${X} (${variations.length})`);
    for (const v of variations) {
      const tierColor = v.tier === 3 ? R : v.tier === 2 ? Y : G;
      const pipeline = v.expectedTaskSequence
        ? ` ${D}[${v.expectedTaskSequence.map((s) => s.taskType).join(" → ")}]${X}`
        : "";
      console.log(`    ${tierColor}T${v.tier}${X} ${v.id}`);
      console.log(`       ${D}${v.prompt.slice(0, 100)}${v.prompt.length > 100 ? "..." : ""}${X}${pipeline}`);
    }
    console.log("");
  }

  console.log(`${D}Run all:  pnpm eval -- --task-type ${taskType}${X}`);
  console.log(`${D}One test: pnpm eval -- --task-type ${taskType} --one-per-type${X}`);

  try {
    const dbStats = getTopFailingTaskTypes(50);
    const match = dbStats.find((s) => s.taskType === taskType || s.taskType.startsWith(taskType));
    if (match) {
      const rateColor = match.successRate >= 80 ? G : match.successRate >= 50 ? Y : R;
      console.log(
        `\n${BOLD}Solve History:${X} ${rateColor}${match.successRate}%${X} success (${match.passed}/${match.total}) | avg ${match.avgCalls} calls, ${match.avgErrors} errors, ${(match.avgMs / 1000).toFixed(1)}s`,
      );
    }
  } catch {
    // DB not available
  }
}

function showWorstTaskTypes() {
  const stats = getTopFailingTaskTypes(10);
  console.log(`${BOLD}Top Failing Task Types${X} (from solve database)\n`);

  if (stats.length === 0) {
    console.log(`${D}No solve data available yet. Run some evals first.${X}`);
    return;
  }

  console.log(`${"Rate".padStart(5)}  ${"Pass".padStart(4)}/${"Total".padEnd(5)}  ${"Avg Calls".padStart(9)}  ${"Avg Err".padStart(7)}  Task Type`);
  console.log("-".repeat(75));

  for (const s of stats) {
    const c = s.successRate >= 80 ? G : s.successRate >= 50 ? Y : R;
    console.log(
      `${c}${(s.successRate + "%").padStart(5)}${X}  ${String(s.passed).padStart(4)}/${String(s.total).padEnd(5)}  ${String(s.avgCalls).padStart(9)}  ${String(s.avgErrors).padStart(7)}  ${s.taskType}`,
    );
    if (s.lastError) {
      console.log(`${D}       └─ ${s.lastError.slice(0, 90)}${X}`);
    }
  }

  const topTypes = stats.filter((s) => s.failed > 0).slice(0, 5);
  if (topTypes.length > 0) {
    console.log(`\n${D}Run worst 5: pnpm eval -- --worst 5 --one-per-type${X}`);
  }
}

main();
