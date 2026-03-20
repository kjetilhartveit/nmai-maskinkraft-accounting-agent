import db from "../lib/db.js";

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

  const prompts = Array.from(promptMap.values()).sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));

  console.log(`\nUnique prompts: ${prompts.length}`);
  console.log(JSON.stringify(prompts, null, 2));
}

main();
