import "dotenv/config";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dirname, "../../data");
const PROMPTS_FILE = join(DATA_DIR, "solve-logs/prompts.jsonl");
const SOLVES_FILE = join(DATA_DIR, "solve-logs/solves.jsonl");
const CANDIDATES_DIR = join(DATA_DIR, "eval-candidates");
const PROMOTED_FILE = join(DATA_DIR, "verified/promoted-test-cases.json");

interface PromptEntry {
  id: string;
  timestamp: string;
  prompt: string;
  taskTypes: string[];
  success: boolean;
  source: string;
}

interface SolveEntry {
  id: string;
  success: boolean;
  error?: string;
  source: string;
  apiCallStats: { total: number; errors: number };
}

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).length;
}

function loadJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as T);
}

function loadJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf-8")) as T; } catch { return null; }
}

function run(cmd: string, label: string): boolean {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`▶ ${label}`);
  console.log(`  $ ${cmd}`);
  console.log("─".repeat(60));
  try {
    execSync(cmd, { stdio: "inherit", cwd: join(import.meta.dirname, "../..") });
    return true;
  } catch {
    console.error(`  ✗ ${label} failed`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const skipEval = args.includes("--skip-eval");
  const skipIngest = args.includes("--skip-ingest");
  const skipVerify = args.includes("--skip-verify");

  console.log("╔══════════════════════════════════════════╗");
  console.log("║       Feedback Loop — Full Pipeline      ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // Step 1: Status overview
  console.log("📊 Current Status:");
  const prompts = loadJsonl<PromptEntry>(PROMPTS_FILE);
  const solves = loadJsonl<SolveEntry>(SOLVES_FILE);
  const promoted = loadJson<unknown[]>(PROMOTED_FILE) ?? [];

  const compPrompts = prompts.filter(p => p.source === "competition");
  const successes = solves.filter(s => s.success);
  const failures = solves.filter(s => !s.success);
  const errors = solves.reduce((sum, s) => sum + (s.apiCallStats?.errors ?? 0), 0);

  console.log(`  Logged solves: ${solves.length} (${successes.length} ok, ${failures.length} failed)`);
  console.log(`  Competition solves: ${compPrompts.length}`);
  console.log(`  Total API errors: ${errors}`);
  console.log(`  Promoted test cases: ${promoted.length}`);

  if (failures.length > 0) {
    console.log(`\n⚠ Recent failures:`);
    const recentFails = failures.slice(-5);
    for (const f of recentFails) {
      console.log(`  - ${f.id} [${f.source}]: ${f.error?.slice(0, 100) ?? "unknown"}`);
    }
  }

  // Step 2: Ingest new prompts
  if (!skipIngest) {
    const novelCount = countLines(PROMPTS_FILE);
    if (novelCount > 0) {
      run("pnpm ingest", "Step 1: Ingest logged prompts → eval candidates");
    } else {
      console.log("\n⏭ No prompts to ingest (no logged prompts yet)");
    }
  } else {
    console.log("\n⏭ Skipping ingestion (--skip-ingest)");
  }

  // Step 3: Verify candidates
  if (!skipVerify) {
    const candidateFiles = existsSync(CANDIDATES_DIR)
      ? require("fs").readdirSync(CANDIDATES_DIR).filter((f: string) => f.endsWith(".json"))
      : [];
    if (candidateFiles.length > 0) {
      run("pnpm verify", "Step 2: Verify candidates → promote test cases");
    } else {
      console.log("\n⏭ No candidates to verify");
    }
  } else {
    console.log("\n⏭ Skipping verification (--skip-verify)");
  }

  // Step 4: Run eval
  if (!skipEval) {
    run("pnpm eval -- --iterations 1", "Step 3: Run eval suite");
  } else {
    console.log("\n⏭ Skipping eval (--skip-eval)");
  }

  // Step 5: Summary
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║           Pipeline Complete              ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const updatedPromoted = loadJson<unknown[]>(PROMOTED_FILE) ?? [];
  console.log("📊 Updated Status:");
  console.log(`  Total test cases (manual + promoted): ${9 + updatedPromoted.length}`);
  console.log(`  Promoted test cases: ${updatedPromoted.length}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Submit to competition:  pnpm submit`);
  console.log(`  2. Monitor dashboard:      pnpm dashboard`);
  console.log(`  3. Run feedback again:     pnpm feedback`);
  console.log(`  4. Compare models:         pnpm eval:compare`);
}

main().catch(console.error);
