import Database from "better-sqlite3";
import { join } from "path";

const SOURCE_DB = "C:/git/nmai-maskinkraft/tripletex/nmiai_dump.db";
const TARGET_DB = join(import.meta.dirname, "../../data/agent.db");

interface SourceTask {
  task_id: number;
  received_at: number;
  prompt: string;
  language: string | null;
  files_count: number;
  base_url: string | null;
  status: string | null;
  elapsed_s: number | null;
  real_api_calls: number;
  real_api_errors: number;
  checks_total: number | null;
  checks_passed: number | null;
  notes: string | null;
  recording: string | null;
}

function main() {
  const srcDb = new Database(SOURCE_DB, { readonly: true });
  const tgtDb = new Database(TARGET_DB);

  // Get existing prompts to avoid duplicates
  const existingPrompts = new Set(
    (tgtDb.prepare("SELECT prompt FROM solves").all() as { prompt: string }[])
      .map((r) => r.prompt.trim().toLowerCase())
  );
  console.log(`Target DB has ${existingPrompts.size} existing solves`);

  // Get source tasks
  const sourceTasks = srcDb.prepare("SELECT * FROM tasks").all() as SourceTask[];
  console.log(`Source DB has ${sourceTasks.length} tasks`);

  const insert = tgtDb.prepare(`
    INSERT INTO solves (id, timestamp, prompt, files_count, base_url, parsed_sequence,
                        api_call_total, api_call_errors, elapsed_ms, success, error, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let skipped = 0;

  const insertMany = tgtDb.transaction((tasks: SourceTask[]) => {
    for (const task of tasks) {
      const normalizedPrompt = task.prompt.trim().toLowerCase();

      if (existingPrompts.has(normalizedPrompt)) {
        skipped++;
        continue;
      }

      // Convert received_at (unix timestamp) to ISO string
      const timestamp = new Date(task.received_at * 1000).toISOString();

      // Determine success based on status and checks
      const success = task.status === "completed" &&
        (task.checks_passed === null || task.checks_passed > 0) ? 1 : 0;

      insert.run(
        String(task.task_id),
        timestamp,
        task.prompt,
        task.files_count ?? 0,
        task.base_url,
        task.recording, // parsed_sequence if available
        task.real_api_calls ?? 0,
        task.real_api_errors ?? 0,
        task.elapsed_s ? Math.round(task.elapsed_s * 1000) : null,
        success,
        task.notes || null,
        "nmiai_dump"
      );

      existingPrompts.add(normalizedPrompt);
      imported++;
    }
  });

  insertMany(sourceTasks);

  console.log(`\nImported: ${imported}`);
  console.log(`Skipped (duplicates): ${skipped}`);

  // Show final count
  const finalCount = tgtDb.prepare("SELECT COUNT(*) as cnt FROM solves").get() as { cnt: number };
  console.log(`Total solves in target DB: ${finalCount.cnt}`);

  srcDb.close();
  tgtDb.close();
}

main();
