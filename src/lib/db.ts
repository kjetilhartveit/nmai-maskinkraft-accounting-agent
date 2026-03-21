import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dirname, "../../data");
const DB_PATH = join(DATA_DIR, "agent.db");

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS solves (
    id               TEXT PRIMARY KEY,
    timestamp        TEXT NOT NULL,
    prompt           TEXT NOT NULL,
    files_count      INTEGER DEFAULT 0,
    base_url         TEXT,
    parsed_sequence  TEXT,
    api_calls        TEXT,
    api_call_total   INTEGER DEFAULT 0,
    api_call_errors  INTEGER DEFAULT 0,
    api_call_duration INTEGER DEFAULT 0,
    elapsed_ms       INTEGER,
    success          INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    source           TEXT NOT NULL,
    score_earned     REAL,
    score_max        REAL
  );

  CREATE TABLE IF NOT EXISTS raw_requests (
    id        TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    headers   TEXT,
    body      TEXT
  );

  CREATE TABLE IF NOT EXISTS captures (
    id               TEXT PRIMARY KEY,
    prompt           TEXT NOT NULL,
    timestamp        TEXT NOT NULL,
    model            TEXT,
    parsed_sequence  TEXT,
    api_call_total   INTEGER DEFAULT 0,
    api_call_errors  INTEGER DEFAULT 0,
    api_call_details TEXT,
    elapsed_ms       INTEGER,
    success          INTEGER DEFAULT 0,
    error            TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_solves_timestamp ON solves(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_solves_source ON solves(source);
  CREATE INDEX IF NOT EXISTS idx_solves_prompt ON solves(prompt);
  CREATE INDEX IF NOT EXISTS idx_raw_requests_timestamp ON raw_requests(timestamp DESC);
`);

// Migration: add new columns if they don't exist (for existing databases)
const columns = db.pragma("table_info(solves)") as { name: string }[];
const columnNames = new Set(columns.map((c) => c.name));
if (!columnNames.has("score_earned")) {
  db.exec("ALTER TABLE solves ADD COLUMN score_earned REAL");
}
if (!columnNames.has("score_max")) {
  db.exec("ALTER TABLE solves ADD COLUMN score_max REAL");
}

export default db;
export { DB_PATH };
