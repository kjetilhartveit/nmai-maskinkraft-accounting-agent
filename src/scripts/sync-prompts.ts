import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import db from "../lib/db.js";

const PROJECT_ROOT = join(import.meta.dirname, "../..");
const DEFAULT_TARGET_REPO = resolve(PROJECT_ROOT, "../nmai-maskinkraft");
const TARGET_FILE = "tripletex/shared-prompts.json";

interface SolveRow {
  id: string;
  timestamp: string;
  prompt: string;
  parsed_sequence: string | null;
  api_call_total: number;
  api_call_errors: number;
  success: number;
  source: string;
}

interface SharedPrompt {
  prompt: string;
  language: string;
  taskTypes: string[];
  source: string;
  firstSeen: string;
  bestApiCalls: number;
  bestErrors: number;
  successCount: number;
  attemptCount: number;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

function main() {
  const args = process.argv.slice(2);
  const targetRepo = args.find((a) => a.startsWith("--target="))?.split("=")[1] ?? DEFAULT_TARGET_REPO;
  const dryRun = args.includes("--dry-run");

  const targetPath = join(targetRepo, TARGET_FILE);

  if (!existsSync(targetRepo)) {
    console.error(`Target repo not found: ${targetRepo}`);
    console.error("Use --target=/path/to/nmai-maskinkraft to specify the repo location.");
    process.exit(1);
  }

  const solves = db.prepare(
    "SELECT id, timestamp, prompt, parsed_sequence, api_call_total, api_call_errors, success, source FROM solves ORDER BY timestamp",
  ).all() as SolveRow[];
  console.log(`Loaded ${solves.length} solve entries from database`);

  const promptMap = new Map<string, SharedPrompt>();
  for (const s of solves) {
    if (!s.prompt || s.prompt.trim().length === 0) continue;

    const key = normalizePrompt(s.prompt);
    const existing = promptMap.get(key);

    const seq = s.parsed_sequence ? JSON.parse(s.parsed_sequence) : null;
    const taskTypes = seq?.tasks?.map((t: { taskType: string }) => t.taskType) ?? [];
    const language = seq?.language ?? "unknown";
    const apiCalls = s.api_call_total ?? 0;
    const apiErrors = s.api_call_errors ?? 0;
    const success = s.success === 1;

    if (existing) {
      existing.attemptCount++;
      if (success) {
        existing.successCount++;
        if (apiCalls > 0 && (existing.bestApiCalls === 0 || apiCalls < existing.bestApiCalls || (apiCalls === existing.bestApiCalls && apiErrors < existing.bestErrors))) {
          existing.bestApiCalls = apiCalls;
          existing.bestErrors = apiErrors;
        }
      }
      if (s.timestamp < existing.firstSeen) {
        existing.firstSeen = s.timestamp;
      }
      if (taskTypes.length > existing.taskTypes.length) {
        existing.taskTypes = taskTypes;
      }
    } else {
      promptMap.set(key, {
        prompt: s.prompt.trim(),
        language,
        taskTypes,
        source: s.source,
        firstSeen: s.timestamp,
        bestApiCalls: success && apiCalls > 0 ? apiCalls : 0,
        bestErrors: success ? apiErrors : 0,
        successCount: success ? 1 : 0,
        attemptCount: 1,
      });
    }
  }

  let existingShared: SharedPrompt[] = [];
  if (existsSync(targetPath)) {
    try {
      existingShared = JSON.parse(readFileSync(targetPath, "utf-8"));
      console.log(`Found ${existingShared.length} existing shared prompts in target`);
    } catch {
      console.warn("Could not parse existing shared prompts, starting fresh.");
    }
  }

  let added = 0;
  let updated = 0;

  for (const [key, entry] of promptMap) {
    const existingIdx = existingShared.findIndex((p) => normalizePrompt(p.prompt) === key);
    if (existingIdx >= 0) {
      const ex = existingShared[existingIdx];
      let changed = false;

      if (entry.bestApiCalls > 0 && (ex.bestApiCalls === 0 || entry.bestApiCalls < ex.bestApiCalls || (entry.bestApiCalls === ex.bestApiCalls && entry.bestErrors < ex.bestErrors))) {
        ex.bestApiCalls = entry.bestApiCalls;
        ex.bestErrors = entry.bestErrors;
        changed = true;
      }
      ex.attemptCount = Math.max(ex.attemptCount, entry.attemptCount);
      ex.successCount = Math.max(ex.successCount, entry.successCount);

      if (changed) updated++;
    } else {
      existingShared.push(entry);
      added++;
    }
  }

  existingShared.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));

  console.log(`\nSync summary:`);
  console.log(`  New prompts to add: ${added}`);
  console.log(`  Existing prompts updated: ${updated}`);
  console.log(`  Total shared prompts: ${existingShared.length}`);

  if (dryRun) {
    console.log("\n[DRY RUN] No files written.");
    return;
  }

  if (added === 0 && updated === 0) {
    console.log("\nNothing new to sync.");
    return;
  }

  writeFileSync(targetPath, JSON.stringify(existingShared, null, 2) + "\n");
  console.log(`\nWritten to ${targetPath}`);
}

main();
