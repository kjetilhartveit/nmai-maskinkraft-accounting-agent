import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const SOLVES_FILE = join(import.meta.dirname, "../../data/solve-logs/solves.jsonl");
const PROJECT_ROOT = join(import.meta.dirname, "../..");
const DEFAULT_TARGET_REPO = resolve(PROJECT_ROOT, "../nmai-maskinkraft");
const TARGET_FILE = "tripletex/shared-prompts.json";

interface SolveEntry {
  id: string;
  timestamp: string;
  prompt: string;
  parsedSequence?: {
    tasks: { taskType: string; entities: Record<string, unknown>[] }[];
    language: string;
  };
  apiCallStats: { total: number; errors: number; totalDuration: number };
  success: boolean;
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

function loadJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
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

  if (!existsSync(SOLVES_FILE)) {
    console.log("No solves.jsonl found — nothing to sync.");
    return;
  }

  const solves = loadJsonl<SolveEntry>(SOLVES_FILE);
  console.log(`Loaded ${solves.length} solve entries from solves.jsonl`);

  // Group by normalized prompt, aggregate stats
  const promptMap = new Map<string, SharedPrompt>();
  for (const s of solves) {
    if (!s.prompt || s.prompt.trim().length === 0) continue;

    const key = normalizePrompt(s.prompt);
    const existing = promptMap.get(key);

    const taskTypes = s.parsedSequence?.tasks?.map((t) => t.taskType) ?? [];
    const language = s.parsedSequence?.language ?? "unknown";
    const apiCalls = s.apiCallStats?.total ?? 0;
    const apiErrors = s.apiCallStats?.errors ?? 0;

    if (existing) {
      existing.attemptCount++;
      if (s.success) {
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
        bestApiCalls: s.success && apiCalls > 0 ? apiCalls : 0,
        bestErrors: s.success ? apiErrors : 0,
        successCount: s.success ? 1 : 0,
        attemptCount: 1,
      });
    }
  }

  // Load existing shared prompts from target
  let existingShared: SharedPrompt[] = [];
  if (existsSync(targetPath)) {
    try {
      existingShared = JSON.parse(readFileSync(targetPath, "utf-8"));
      console.log(`Found ${existingShared.length} existing shared prompts in target`);
    } catch {
      console.warn("Could not parse existing shared prompts, starting fresh.");
    }
  }

  const existingKeys = new Set(existingShared.map((p) => normalizePrompt(p.prompt)));

  // Merge: add new unique prompts, update existing ones with better stats
  let added = 0;
  let updated = 0;

  for (const [key, entry] of promptMap) {
    const existingIdx = existingShared.findIndex((p) => normalizePrompt(p.prompt) === key);
    if (existingIdx >= 0) {
      const ex = existingShared[existingIdx];
      let changed = false;

      if (entry.bestApiCalls < ex.bestApiCalls || (entry.bestApiCalls === ex.bestApiCalls && entry.bestErrors < ex.bestErrors)) {
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
