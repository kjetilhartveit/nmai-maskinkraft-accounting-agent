import { readFileSync, existsSync } from "fs";
import { join } from "path";
import db, { DB_PATH } from "../lib/db.js";

const DATA_DIR = join(import.meta.dirname, "../../data");
const SOLVES_FILE = join(DATA_DIR, "solve-logs/solves.jsonl");
const RAW_REQUESTS_FILE = join(DATA_DIR, "solve-logs/raw-requests.jsonl");
const CAPTURES_FILE = join(DATA_DIR, "captures/runs.jsonl");

function loadJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

interface OldSolve {
  id: string;
  timestamp: string;
  prompt: string;
  filesCount: number;
  baseUrl: string;
  parsedTask?: unknown;
  parsedSequence?: unknown;
  apiCalls: unknown[];
  apiCallStats: { total: number; errors: number; totalDuration: number };
  elapsedMs: number;
  success: boolean;
  error?: string;
  source: string;
}

interface OldRawRequest {
  id: string;
  timestamp: string;
  headers: Record<string, string>;
  body: unknown;
}

interface OldCapture {
  id: string;
  prompt: string;
  timestamp: string;
  model: string;
  parsedSequence?: unknown;
  apiCalls: { total: number; errors: number; details: unknown[] };
  elapsedMs: number;
  success: boolean;
  error?: string;
}

function main() {
  console.log(`Migrating JSONL data to SQLite at ${DB_PATH}\n`);

  // Migrate solves
  if (existsSync(SOLVES_FILE)) {
    const solves = loadJsonl<OldSolve>(SOLVES_FILE);
    console.log(`Found ${solves.length} solves in ${SOLVES_FILE}`);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO solves
       (id, timestamp, prompt, files_count, base_url, parsed_sequence, api_calls,
        api_call_total, api_call_errors, api_call_duration, elapsed_ms, success, error, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertMany = db.transaction((entries: OldSolve[]) => {
      for (const s of entries) {
        const seq = s.parsedSequence ?? s.parsedTask ?? null;
        insert.run(
          s.id,
          s.timestamp,
          s.prompt ?? "",
          s.filesCount ?? 0,
          s.baseUrl ?? "",
          seq ? JSON.stringify(seq) : null,
          JSON.stringify(s.apiCalls ?? []),
          s.apiCallStats?.total ?? 0,
          s.apiCallStats?.errors ?? 0,
          s.apiCallStats?.totalDuration ?? 0,
          s.elapsedMs ?? 0,
          s.success ? 1 : 0,
          s.error ?? null,
          s.source ?? "unknown",
        );
      }
    });

    insertMany(solves);
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM solves").get() as { cnt: number }).cnt;
    console.log(`  → ${count} solves in database\n`);
  } else {
    console.log("No solves.jsonl found, skipping.\n");
  }

  // Migrate raw requests
  if (existsSync(RAW_REQUESTS_FILE)) {
    const raws = loadJsonl<OldRawRequest>(RAW_REQUESTS_FILE);
    console.log(`Found ${raws.length} raw requests in ${RAW_REQUESTS_FILE}`);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO raw_requests (id, timestamp, headers, body)
       VALUES (?, ?, ?, ?)`,
    );

    const insertMany = db.transaction((entries: OldRawRequest[]) => {
      for (const r of entries) {
        insert.run(
          r.id,
          r.timestamp,
          JSON.stringify(r.headers),
          JSON.stringify(r.body),
        );
      }
    });

    insertMany(raws);
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM raw_requests").get() as { cnt: number }).cnt;
    console.log(`  → ${count} raw requests in database\n`);
  } else {
    console.log("No raw-requests.jsonl found, skipping.\n");
  }

  // Migrate captures
  if (existsSync(CAPTURES_FILE)) {
    const captures = loadJsonl<OldCapture>(CAPTURES_FILE);
    console.log(`Found ${captures.length} captures in ${CAPTURES_FILE}`);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO captures
       (id, prompt, timestamp, model, parsed_sequence, api_call_total, api_call_errors, api_call_details, elapsed_ms, success, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertMany = db.transaction((entries: OldCapture[]) => {
      for (const c of entries) {
        insert.run(
          c.id,
          c.prompt,
          c.timestamp,
          c.model ?? null,
          c.parsedSequence ? JSON.stringify(c.parsedSequence) : null,
          c.apiCalls?.total ?? 0,
          c.apiCalls?.errors ?? 0,
          JSON.stringify(c.apiCalls?.details ?? []),
          c.elapsedMs ?? 0,
          c.success ? 1 : 0,
          c.error ?? null,
        );
      }
    });

    insertMany(captures);
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM captures").get() as { cnt: number }).cnt;
    console.log(`  → ${count} captures in database\n`);
  } else {
    console.log("No captures runs.jsonl found, skipping.\n");
  }

  console.log("Migration complete!");
  console.log(`Database: ${DB_PATH}`);
}

main();
