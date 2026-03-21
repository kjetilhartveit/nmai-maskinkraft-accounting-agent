import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import db from "../lib/db.js";
import { ALL_TASK_TYPES } from "../types/index.js";
import { PROMPT_TEMPLATES } from "../lib/task-classifier.js";
import { testCases } from "../eval/test-cases.js";

const PROMOTED_FILE = join(import.meta.dirname, "../../data/verified/promoted-test-cases.json");
const PORT = 3001;

interface SolveRow {
  id: string;
  timestamp: string;
  prompt: string;
  files_count: number;
  base_url: string;
  parsed_sequence: string | null;
  api_calls: string | null;
  api_call_total: number;
  api_call_errors: number;
  api_call_duration: number;
  elapsed_ms: number;
  success: number;
  error: string | null;
  source: string;
  classified_type: string | null;
}

interface SolveEntry {
  id: string;
  timestamp: string;
  prompt: string;
  filesCount: number;
  baseUrl: string;
  parsedSequence?: { tasks: { taskType: string; entities: Record<string, unknown>[] }[]; language: string };
  apiCalls: { method: string; endpoint: string; status: number; durationMs: number; isError: boolean; errorBody?: string }[];
  apiCallStats: { total: number; errors: number; totalDuration: number };
  elapsedMs: number;
  success: boolean;
  error?: string;
  source: string;
}

function rowToSolveEntry(row: SolveRow): SolveEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    prompt: row.prompt,
    filesCount: row.files_count,
    baseUrl: row.base_url,
    parsedSequence: row.parsed_sequence ? JSON.parse(row.parsed_sequence) : undefined,
    apiCalls: row.api_calls ? JSON.parse(row.api_calls) : [],
    apiCallStats: { total: row.api_call_total, errors: row.api_call_errors, totalDuration: row.api_call_duration },
    elapsedMs: row.elapsed_ms,
    success: row.success === 1,
    error: row.error ?? undefined,
    source: row.source,
  };
}

function loadSolves(source?: string): SolveEntry[] {
  const stmt = source
    ? db.prepare("SELECT * FROM solves WHERE source = ? ORDER BY timestamp DESC")
    : db.prepare("SELECT * FROM solves ORDER BY timestamp DESC");
  const rows = (source ? stmt.all(source) : stmt.all()) as SolveRow[];
  return rows.map(rowToSolveEntry);
}

function loadPromoted(): number {
  if (!existsSync(PROMOTED_FILE)) return 0;
  try {
    return (JSON.parse(readFileSync(PROMOTED_FILE, "utf-8")) as unknown[]).length;
  } catch { return 0; }
}

const app = new Hono();

app.get("/api/solves", (c) => {
  const source = c.req.query("source");
  return c.json(loadSolves(source ?? undefined));
});

app.get("/api/raw-requests", (c) => {
  const rows = db.prepare("SELECT * FROM raw_requests ORDER BY timestamp DESC").all() as { id: string; timestamp: string; headers: string; body: string }[];
  return c.json(rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    headers: JSON.parse(r.headers),
    body: JSON.parse(r.body),
  })));
});

app.get("/api/stats", (c) => {
  const solves = loadSolves();
  const promoted = loadPromoted();
  const bySource = { competition: 0, eval: 0, manual: 0 };
  let totalCalls = 0, totalErrors = 0, successes = 0;

  for (const s of solves) {
    bySource[s.source as keyof typeof bySource] = (bySource[s.source as keyof typeof bySource] ?? 0) + 1;
    totalCalls += s.apiCallStats?.total ?? 0;
    totalErrors += s.apiCallStats?.errors ?? 0;
    if (s.success) successes++;
  }

  const compSolves = solves.filter(s => s.source === "competition");
  const compSuccess = compSolves.filter(s => s.success).length;

  return c.json({
    totalSolves: solves.length,
    successes,
    failures: solves.length - successes,
    successRate: solves.length > 0 ? Math.round((successes / solves.length) * 100) : 0,
    bySource,
    competition: {
      total: compSolves.length,
      successes: compSuccess,
      failures: compSolves.length - compSuccess,
      lastSolve: compSolves.length > 0 ? compSolves[0] : null,
    },
    totalApiCalls: totalCalls,
    totalApiErrors: totalErrors,
    promotedTestCases: promoted,
    lastSolve: solves.length > 0 ? solves[0] : null,
  });
});

app.get("/api/task-analysis", (c) => {
  const solves = loadSolves();
  const byTaskType: Record<string, { total: number; passed: number; failed: number; avgMs: number; avgCalls: number; avgErrors: number; solves: SolveEntry[] }> = {};

  for (const s of solves) {
    const tasks = s.parsedSequence?.tasks;
    const key = tasks?.map(t => t.taskType).join(" > ") ?? "unknown";
    if (!byTaskType[key]) {
      byTaskType[key] = { total: 0, passed: 0, failed: 0, avgMs: 0, avgCalls: 0, avgErrors: 0, solves: [] };
    }
    const group = byTaskType[key];
    group.total++;
    if (s.success) group.passed++;
    else group.failed++;
    group.solves.push(s);
  }

  for (const [, group] of Object.entries(byTaskType)) {
    group.avgMs = Math.round(group.solves.reduce((s, e) => s + e.elapsedMs, 0) / group.total);
    group.avgCalls = Math.round(group.solves.reduce((s, e) => s + (e.apiCallStats?.total ?? 0), 0) / group.total * 10) / 10;
    group.avgErrors = Math.round(group.solves.reduce((s, e) => s + (e.apiCallStats?.errors ?? 0), 0) / group.total * 10) / 10;
  }

  const sorted = Object.entries(byTaskType)
    .map(([taskType, data]) => ({
      taskType,
      ...data,
      successRate: data.total > 0 ? Math.round((data.passed / data.total) * 100) : 0,
      solves: data.solves.slice(0, 10).map(s => ({
        id: s.id,
        timestamp: s.timestamp,
        success: s.success,
        apiCalls: s.apiCallStats?.total ?? 0,
        errors: s.apiCallStats?.errors ?? 0,
        elapsedMs: s.elapsedMs,
        error: s.error,
        prompt: s.prompt?.slice(0, 100),
        source: s.source,
      })),
    }))
    .sort((a, b) => {
      if (a.failed !== b.failed) return b.failed - a.failed;
      return b.total - a.total;
    });

  return c.json(sorted);
});

app.get("/api/task-type-registry", (c) => {
  const sourceFilter = c.req.query("source");

  const solveQuery = sourceFilter
    ? db.prepare(
        `SELECT classified_type, success, api_call_total, api_call_errors, elapsed_ms, source
         FROM solves WHERE source = ? ORDER BY timestamp DESC`,
      )
    : db.prepare(
        `SELECT classified_type, success, api_call_total, api_call_errors, elapsed_ms, source
         FROM solves ORDER BY timestamp DESC`,
      );
  const solveRows = (sourceFilter ? solveQuery.all(sourceFilter) : solveQuery.all()) as {
    classified_type: string | null;
    success: number;
    api_call_total: number;
    api_call_errors: number;
    elapsed_ms: number;
    source: string;
  }[];

  const evalCasesByType: Record<string, number> = {};
  for (const tc of testCases) {
    evalCasesByType[tc.taskType] = (evalCasesByType[tc.taskType] || 0) + 1;
    if (tc.expectedTaskSequence) {
      for (const step of tc.expectedTaskSequence) {
        if (step.taskType !== tc.taskType) {
          evalCasesByType[step.taskType] = (evalCasesByType[step.taskType] || 0) + 1;
        }
      }
    }
  }

  const solveStatsByType: Record<string, { total: number; passed: number; failed: number; avgMs: number; avgCalls: number; avgErrors: number; bySource: Record<string, { total: number; passed: number; failed: number }> }> = {};

  for (const row of solveRows) {
    // Use classified_type from database as source of truth
    const tt = row.classified_type || "unknown";

    if (!solveStatsByType[tt]) {
      solveStatsByType[tt] = { total: 0, passed: 0, failed: 0, avgMs: 0, avgCalls: 0, avgErrors: 0, bySource: {} };
    }
    const stats = solveStatsByType[tt];
    stats.total++;
    if (row.success) stats.passed++;
    else stats.failed++;
    stats.avgMs += row.elapsed_ms;
    stats.avgCalls += row.api_call_total;
    stats.avgErrors += row.api_call_errors;

    if (!stats.bySource[row.source]) {
      stats.bySource[row.source] = { total: 0, passed: 0, failed: 0 };
    }
    stats.bySource[row.source].total++;
    if (row.success) stats.bySource[row.source].passed++;
    else stats.bySource[row.source].failed++;
  }

  for (const stats of Object.values(solveStatsByType)) {
    if (stats.total > 0) {
      stats.avgMs = Math.round(stats.avgMs / stats.total);
      stats.avgCalls = Math.round((stats.avgCalls / stats.total) * 10) / 10;
      stats.avgErrors = Math.round((stats.avgErrors / stats.total) * 10) / 10;
    }
  }

  const registry = ALL_TASK_TYPES.map((taskType) => {
    const template = PROMPT_TEMPLATES.find((t: { taskType: string }) => t.taskType === taskType);
    const stats = solveStatsByType[taskType];
    return {
      taskType,
      description: template?.template?.slice(0, 100) ?? "",
      handlerType: "dedicated" as const,
      evalCases: evalCasesByType[taskType] ?? 0,
      solves: stats ?? { total: 0, passed: 0, failed: 0, avgMs: 0, avgCalls: 0, avgErrors: 0, bySource: {} },
    };
  });

  registry.sort((a: { solves: { failed: number; total: number } }, b: { solves: { failed: number; total: number } }) => {
    if (b.solves.failed !== a.solves.failed) return b.solves.failed - a.solves.failed;
    return b.solves.total - a.solves.total;
  });

  const totals = {
    types: registry.length,
    dedicated: registry.length,
    generic: 0,
    withEvals: registry.filter((r) => r.evalCases > 0).length,
    totalEvalCases: Object.values(evalCasesByType).reduce((s, v) => s + v, 0),
    totalSolves: solveRows.length,
  };

  return c.json({ registry, totals });
});

app.get("/api/stream", (c) => {
  let lastCount = (db.prepare("SELECT COUNT(*) as cnt FROM solves").get() as { cnt: number }).cnt;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "connected", solveCount: lastCount });

      const interval = setInterval(() => {
        const current = (db.prepare("SELECT COUNT(*) as cnt FROM solves").get() as { cnt: number }).cnt;
        if (current > lastCount) {
          const newRows = db.prepare(
            "SELECT * FROM solves ORDER BY timestamp DESC LIMIT ?",
          ).all(current - lastCount) as SolveRow[];
          for (const row of newRows) {
            send({ type: "solve", data: rowToSolveEntry(row) });
          }
          lastCount = current;
        }
      }, 1000);

      c.req.raw.signal.addEventListener("abort", () => clearInterval(interval));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

app.get("/", (c) => {
  return c.html(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Accounting Agent Dashboard</title>
  <style>
    :root { --bg: #0f1117; --card: #1a1d27; --border: #2a2d3a; --text: #e1e4eb; --muted: #8b8fa3; --green: #22c55e; --red: #ef4444; --yellow: #eab308; --blue: #3b82f6; --purple: #a855f7; --orange: #f97316; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; max-width: 1400px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    .subtitle { color: var(--muted); font-size: 0.85rem; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .stat-card.highlight { border-color: var(--purple); background: rgba(168,85,247,0.05); }
    .stat-card .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-card .value { font-size: 1.75rem; font-weight: 700; margin-top: 4px; }
    .stat-card .sub { color: var(--muted); font-size: 0.75rem; margin-top: 2px; }
    .success { color: var(--green); }
    .failure { color: var(--red); }
    .info { color: var(--blue); }
    .warn { color: var(--yellow); }

    .tabs { display: flex; gap: 2px; margin-bottom: 2px; }
    .tab { padding: 8px 20px; background: var(--card); border: 1px solid var(--border); border-bottom: none; border-radius: 8px 8px 0 0; cursor: pointer; color: var(--muted); font-size: 0.85rem; font-weight: 500; transition: all 0.15s; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--text); background: var(--bg); border-color: var(--border); border-bottom-color: var(--bg); }
    .tab .count { display: inline-block; background: var(--border); color: var(--muted); padding: 1px 6px; border-radius: 9999px; font-size: 0.7rem; margin-left: 6px; }
    .tab.active .count { background: var(--blue); color: white; }
    .tab-content { display: none; border: 1px solid var(--border); border-radius: 0 8px 8px 8px; padding: 16px; background: var(--card); }
    .tab-content.active { display: block; }

    .section { margin-bottom: 24px; }
    .section h2 { font-size: 1.1rem; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; }
    .badge.live { background: rgba(34,197,94,0.15); color: var(--green); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .badge.comp { background: rgba(168,85,247,0.15); color: var(--purple); }
    .badge.eval { background: rgba(59,130,246,0.15); color: var(--blue); }
    .badge.manual { background: rgba(139,143,163,0.15); color: var(--muted); }
    .badge.ok { background: rgba(34,197,94,0.15); color: var(--green); }
    .badge.err { background: rgba(239,68,68,0.15); color: var(--red); }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 0.75rem; text-transform: uppercase; }
    td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.8rem; }
    .prompt-text { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: help; }
    .api-call { display: flex; gap: 6px; align-items: center; margin: 3px 0; font-size: 0.78rem; padding: 2px 0; }
    .api-call .method { font-weight: 600; min-width: 50px; }
    .api-call .endpoint { color: var(--muted); flex: 1; }
    .api-call .status-ok { color: var(--green); }
    .api-call .status-err { color: var(--red); font-weight: 600; }
    .api-call .duration { color: var(--muted); font-size: 0.72rem; }
    .api-call-error { background: rgba(239,68,68,0.06); border-left: 3px solid var(--red); padding: 6px 10px; margin: 2px 0 6px 0; border-radius: 0 4px 4px 0; font-size: 0.75rem; color: var(--red); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }
    .expand-btn { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 0.72rem; }
    .expand-btn:hover { border-color: var(--text); color: var(--text); }
    .details { display: none; background: var(--bg); padding: 16px; border-radius: 8px; margin-top: 8px; font-size: 0.82rem; }
    .details.open { display: block; }
    .details pre { white-space: pre-wrap; word-break: break-all; color: var(--muted); background: var(--card); padding: 10px; border-radius: 6px; margin-top: 4px; max-height: 400px; overflow-y: auto; font-size: 0.78rem; }
    .details h4 { margin-top: 12px; margin-bottom: 4px; font-size: 0.85rem; }
    .details h4:first-child { margin-top: 0; }
    .entity-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 8px; margin-top: 6px; }
    .entity-card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 0.78rem; }
    .entity-card .entity-type { color: var(--blue); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; margin-bottom: 4px; }
    .entity-card .entity-field { display: flex; gap: 6px; }
    .entity-card .entity-field .key { color: var(--muted); min-width: 80px; }
    .empty-state { padding: 40px; text-align: center; color: var(--muted); font-size: 0.9rem; }
    #connection-status { position: fixed; top: 12px; right: 20px; z-index: 10; }

    .task-filter { background: var(--bg); border: 1px solid var(--border); color: var(--muted); border-radius: 6px; padding: 5px 14px; cursor: pointer; font-size: 0.78rem; font-weight: 500; transition: all 0.15s; }
    .task-filter:hover { border-color: var(--text); color: var(--text); }
    .task-filter.active { background: var(--blue); border-color: var(--blue); color: white; }

    .task-summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 18px; }
    .task-summary-card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; text-align: center; }
    .task-summary-card .tsc-label { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .task-summary-card .tsc-value { font-size: 1.4rem; font-weight: 700; margin-top: 2px; }

    .task-registry-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .task-registry-table th { text-align: left; padding: 10px 10px; border-bottom: 2px solid var(--border); color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; }
    .task-registry-table td { padding: 10px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .task-registry-table tr:hover td { background: rgba(255,255,255,0.02); }
    .task-registry-table tr.task-detail-row td { padding: 0; border-bottom: 1px solid var(--border); }
    .task-registry-table tr.task-detail-row .task-detail-content { display: none; padding: 14px 16px; background: var(--bg); }
    .task-registry-table tr.task-detail-row.open .task-detail-content { display: block; }

    .handler-badge { display: inline-block; padding: 3px 10px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em; }
    .handler-badge.dedicated { background: rgba(34,197,94,0.12); color: var(--green); }
    .handler-badge.generic { background: rgba(249,115,22,0.12); color: var(--orange); }
    .handler-badge.fallback { background: rgba(139,143,163,0.12); color: var(--muted); }

    .eval-count { display: inline-block; min-width: 24px; text-align: center; padding: 2px 8px; border-radius: 5px; font-size: 0.78rem; font-weight: 600; }
    .eval-count.has-evals { background: rgba(59,130,246,0.12); color: var(--blue); }
    .eval-count.no-evals { background: rgba(239,68,68,0.08); color: var(--muted); }

    .rate-bar { display: inline-flex; align-items: center; gap: 8px; }
    .rate-bar-track { width: 80px; height: 7px; background: var(--border); border-radius: 4px; overflow: hidden; }
    .rate-bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }

    .source-pips { display: flex; gap: 4px; }
    .source-pip { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 0.68rem; font-weight: 600; }
  </style>
</head>
<body>
  <div id="connection-status"><span class="badge live">LIVE</span></div>
  <h1>Accounting Agent Dashboard</h1>
  <p class="subtitle">Real-time monitoring for NM i AI — Tripletex Accounting Agent</p>

  <div class="grid" id="stats"></div>

  <div class="tabs">
    <div class="tab active" data-tab="competition" onclick="switchTab('competition')">Competition <span class="count" id="comp-count">0</span></div>
    <div class="tab" data-tab="all" onclick="switchTab('all')">All Solves <span class="count" id="all-count">0</span></div>
    <div class="tab" data-tab="eval" onclick="switchTab('eval')">Eval <span class="count" id="eval-count">0</span></div>
    <div class="tab" data-tab="tasks" onclick="switchTab('tasks')">Task Analysis <span class="count" id="tasks-count">0</span></div>
    <div class="tab" data-tab="raw" onclick="switchTab('raw')">Raw Requests <span class="count" id="raw-count">0</span></div>
  </div>

  <div class="tab-content active" id="tab-competition">
    <h2 style="margin-bottom: 12px;">Competition Solves <span class="badge live">live</span></h2>
    <div id="comp-empty" class="empty-state">No competition solves yet. Submit at <a href="https://app.ainm.no/submit/tripletex" target="_blank" style="color:var(--purple)">app.ainm.no</a></div>
    <table id="comp-table" style="display:none;">
      <thead><tr>
        <th>Time</th><th>Status</th><th>Prompt</th><th>Tasks</th><th>API Calls</th><th>Errors</th><th>Duration</th><th></th>
      </tr></thead>
      <tbody id="comp-body"></tbody>
    </table>
  </div>

  <div class="tab-content" id="tab-all">
    <table>
      <thead><tr>
        <th>Time</th><th>Source</th><th>Status</th><th>Prompt</th><th>Tasks</th><th>API Calls</th><th>Errors</th><th>Duration</th><th></th>
      </tr></thead>
      <tbody id="all-body"></tbody>
    </table>
  </div>

  <div class="tab-content" id="tab-eval">
    <table>
      <thead><tr>
        <th>Time</th><th>Status</th><th>Prompt</th><th>Tasks</th><th>API Calls</th><th>Errors</th><th>Duration</th><th></th>
      </tr></thead>
      <tbody id="eval-body"></tbody>
    </table>
  </div>

  <div class="tab-content" id="tab-tasks">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <h2 style="margin-bottom:4px;">Task Type Registry</h2>
        <p style="color:var(--muted);font-size:0.82rem;">All task types with handler mapping, eval coverage, and solve performance. Click a row to expand.</p>
      </div>
      <div style="display:flex;gap:6px;align-items:center;" id="task-filter-bar">
        <span style="color:var(--muted);font-size:0.78rem;margin-right:4px;">Source filter:</span>
        <button class="task-filter active" data-filter="" onclick="setTaskFilter(this, '')">All</button>
        <button class="task-filter" data-filter="eval" onclick="setTaskFilter(this, 'eval')">Eval</button>
        <button class="task-filter" data-filter="competition" onclick="setTaskFilter(this, 'competition')">Competition</button>
        <button class="task-filter" data-filter="manual" onclick="setTaskFilter(this, 'manual')">Manual</button>
      </div>
    </div>
    <div class="task-summary-cards" id="task-summary-cards"></div>
    <table class="task-registry-table">
      <thead>
        <tr>
          <th style="width:22%">Task Type</th>
          <th style="width:12%">Handler</th>
          <th style="width:8%">Eval Cases</th>
          <th style="width:10%">Solves</th>
          <th style="width:14%">Success Rate</th>
          <th style="width:8%">Avg Calls</th>
          <th style="width:8%">Avg Errors</th>
          <th style="width:8%">Avg Time</th>
          <th style="width:10%">By Source</th>
        </tr>
      </thead>
      <tbody id="tasks-body"></tbody>
    </table>
  </div>

  <div class="tab-content" id="tab-raw">
    <p style="color:var(--muted);font-size:0.82rem;margin-bottom:12px;">Raw incoming HTTP request bodies — useful for debugging what the competition platform sends.</p>
    <div id="raw-body"></div>
  </div>

  <script>
    const statsEl = document.getElementById('stats');
    const connStatus = document.getElementById('connection-status');
    let allSolves = [];

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function sourceBadge(source) {
      const cls = source === 'competition' ? 'comp' : source === 'eval' ? 'eval' : 'manual';
      return '<span class="badge ' + cls + '">' + esc(source) + '</span>';
    }

    function statusBadge(success) {
      return success ? '<span class="badge ok">OK</span>' : '<span class="badge err">FAIL</span>';
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleString('nb-NO', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function formatDate(ts) {
      return new Date(ts).toLocaleDateString('nb-NO', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    }

    function detectSessions(solves) {
      const SESSION_GAP_MS = 5 * 60 * 1000;
      let sessionId = 0;
      let lastTs = 0;
      return solves.map(s => {
        const ts = new Date(s.timestamp).getTime();
        if (lastTs === 0 || Math.abs(ts - lastTs) > SESSION_GAP_MS) sessionId++;
        lastTs = ts;
        return { ...s, _sessionId: sessionId };
      });
    }

    function renderStats(data) {
      const compRate = data.competition.total > 0 ? Math.round((data.competition.successes / data.competition.total) * 100) : 0;
      statsEl.innerHTML = [
        { label: 'Competition', value: data.competition.total, cls: 'info', sub: data.competition.successes + ' ok / ' + data.competition.failures + ' fail', highlight: true },
        { label: 'Comp. Success', value: compRate + '%', cls: compRate >= 50 ? 'success' : 'failure', sub: data.competition.total + ' attempts', highlight: true },
        { label: 'Total Solves', value: data.totalSolves, cls: '' },
        { label: 'Overall Rate', value: data.successRate + '%', cls: data.successRate >= 80 ? 'success' : data.successRate >= 50 ? 'warn' : 'failure', sub: data.successes + ' ok / ' + data.failures + ' fail' },
        { label: 'API Calls', value: data.totalApiCalls, cls: '', sub: data.totalApiErrors + ' errors' },
        { label: 'Eval Runs', value: data.bySource.eval, cls: 'info' },
        { label: 'Test Cases', value: 9 + data.promotedTestCases, cls: 'info', sub: data.promotedTestCases + ' promoted' },
      ].map(s => '<div class="stat-card' + (s.highlight ? ' highlight' : '') + '"><div class="label">' + s.label + '</div><div class="value ' + s.cls + '">' + s.value + '</div>' + (s.sub ? '<div class="sub">' + s.sub + '</div>' : '') + '</div>').join('');
    }

    function renderApiCallDetails(apiCalls) {
      if (!apiCalls || apiCalls.length === 0) return '<p style="color:var(--muted)">No API calls</p>';
      return apiCalls.map(c => {
        let html = '<div class="api-call"><span class="method">' + esc(c.method) + '</span> <span class="endpoint">' + esc(c.endpoint) + '</span> <span class="' + (c.isError ? 'status-err' : 'status-ok') + '">' + c.status + '</span> <span class="duration">' + c.durationMs + 'ms</span></div>';
        if (c.isError && c.errorBody) {
          html += '<div class="api-call-error">' + esc(c.errorBody) + '</div>';
        }
        return html;
      }).join('');
    }

    function renderEntities(parsedSequence) {
      if (!parsedSequence?.tasks?.length) return '';
      let html = '<h4>Parsed Entities:</h4><div class="entity-grid">';
      for (const task of parsedSequence.tasks) {
        for (const entity of (task.entities || [])) {
          html += '<div class="entity-card"><div class="entity-type">' + esc(task.taskType) + '</div>';
          for (const [k, v] of Object.entries(entity)) {
            html += '<div class="entity-field"><span class="key">' + esc(k) + '</span><span>' + esc(String(v)) + '</span></div>';
          }
          html += '</div>';
        }
      }
      html += '</div>';
      return html;
    }

    function sessionBadge(sessionId) {
      const colors = ['var(--blue)', 'var(--purple)', 'var(--orange)', 'var(--green)', 'var(--yellow)', 'var(--red)'];
      const color = colors[(sessionId - 1) % colors.length];
      return '<span class="badge" style="background:' + color + '22;color:' + color + ';font-size:0.65rem;">run ' + sessionId + '</span>';
    }

    function renderSolveRow(solve, includeSource) {
      const tasks = solve.parsedSequence?.tasks?.map(t => t.taskType).join(' > ') ?? '-';
      const promptDisplay = solve.prompt ? (solve.prompt.length > 80 ? solve.prompt.slice(0, 80) + '...' : solve.prompt) : '(empty)';
      const tr = document.createElement('tr');
      let cells =
        '<td class="mono"><div>' + formatTime(solve.timestamp) + '</div>' +
        (solve._sessionId ? '<div style="margin-top:2px;">' + sessionBadge(solve._sessionId) + '</div>' : '') +
        '</td>';
      if (includeSource) cells += '<td>' + sourceBadge(solve.source) + '</td>';
      cells +=
        '<td>' + statusBadge(solve.success) + '</td>' +
        '<td class="prompt-text" title="' + esc(solve.prompt || '') + '">' + esc(promptDisplay) + '</td>' +
        '<td class="mono">' + esc(tasks) + '</td>' +
        '<td class="mono">' + (solve.apiCallStats?.total ?? 0) + '</td>' +
        '<td class="mono ' + ((solve.apiCallStats?.errors ?? 0) > 0 ? 'failure' : '') + '">' + (solve.apiCallStats?.errors ?? 0) + '</td>' +
        '<td class="mono">' + (solve.elapsedMs / 1000).toFixed(1) + 's</td>' +
        '<td><button class="expand-btn" onclick="toggleDetails(this)">details</button></td>';
      tr.innerHTML = cells;

      const colspan = includeSource ? 9 : 8;
      const detailRow = document.createElement('tr');
      detailRow.innerHTML = '<td colspan="' + colspan + '"><div class="details">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span class="mono" style="color:var(--muted);font-size:0.72rem;">' + esc(solve.id || '') + '</span>' +
        (solve._sessionId ? sessionBadge(solve._sessionId) : '') + '</div>' +
        (solve.error ? '<h4 style="color:var(--red)">Error:</h4><pre style="border-left:3px solid var(--red);padding-left:10px;">' + esc(solve.error) + '</pre>' : '') +
        renderEntities(solve.parsedSequence) +
        '<h4>API Calls (' + (solve.apiCalls?.length ?? 0) + '):</h4>' +
        renderApiCallDetails(solve.apiCalls) +
        '<h4>Full Prompt:</h4><pre>' + esc(solve.prompt || '(empty)') + '</pre>' +
        '<h4>Base URL:</h4><pre>' + esc(solve.baseUrl || '-') + '</pre>' +
        '</div></td>';
      return [tr, detailRow];
    }

    window.toggleTaskSolves = function(el) {
      const solves = el.parentElement.querySelector('.task-solves');
      solves.style.display = solves.style.display === 'none' ? '' : 'none';
    };

    window.toggleDetails = function(btn) {
      const detailDiv = btn.closest('tr').nextElementSibling.querySelector('.details');
      detailDiv.classList.toggle('open');
      btn.textContent = detailDiv.classList.contains('open') ? 'hide' : 'details';
    };

    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    }

    function renderSolvesToBody(solves, bodyId, includeSource, limit) {
      const body = document.getElementById(bodyId);
      body.innerHTML = '';
      const withSessions = detectSessions([...solves].reverse()).reverse();
      const colspan = includeSource ? 9 : 8;
      let lastDate = '';
      for (const solve of withSessions.slice(0, limit || 100)) {
        const date = formatDate(solve.timestamp);
        if (date !== lastDate) {
          lastDate = date;
          const dateRow = document.createElement('tr');
          dateRow.innerHTML = '<td colspan="' + colspan + '" style="background:var(--bg);padding:10px 12px 6px;font-weight:600;font-size:0.8rem;color:var(--muted);border-bottom:2px solid var(--border);">' + esc(date) + '</td>';
          body.appendChild(dateRow);
        }
        const [row, detail] = renderSolveRow(solve, includeSource);
        body.appendChild(row);
        body.appendChild(detail);
      }
    }

    function updateCounts() {
      const comp = allSolves.filter(s => s.source === 'competition');
      const eval_ = allSolves.filter(s => s.source === 'eval');
      document.getElementById('comp-count').textContent = comp.length;
      document.getElementById('all-count').textContent = allSolves.length;
      document.getElementById('eval-count').textContent = eval_.length;
    }

    function refreshTables() {
      const comp = allSolves.filter(s => s.source === 'competition');
      const eval_ = allSolves.filter(s => s.source === 'eval');

      if (comp.length > 0) {
        document.getElementById('comp-empty').style.display = 'none';
        document.getElementById('comp-table').style.display = '';
        renderSolvesToBody(comp, 'comp-body', false, 50);
      }

      renderSolvesToBody(allSolves, 'all-body', true, 100);
      renderSolvesToBody(eval_, 'eval-body', false, 100);
      updateCounts();
    }

    async function loadRawRequests() {
      try {
        const res = await fetch('/api/raw-requests');
        const raws = await res.json();
        const container = document.getElementById('raw-body');
        document.getElementById('raw-count').textContent = raws.length;
        if (raws.length === 0) {
          container.innerHTML = '<div class="empty-state">No raw requests logged yet.</div>';
          return;
        }
        container.innerHTML = raws.map(r =>
          '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span class="mono" style="font-size:0.78rem;">' + esc(r.id || '') + '</span><span class="mono" style="color:var(--muted);font-size:0.75rem;">' + esc(r.timestamp || '') + '</span></div>' +
          '<h4 style="font-size:0.8rem;margin-bottom:4px;">Headers:</h4><pre style="font-size:0.72rem;">' + esc(JSON.stringify(r.headers, null, 2)) + '</pre>' +
          '<h4 style="font-size:0.8rem;margin:8px 0 4px;">Body:</h4><pre style="font-size:0.72rem;">' + esc(JSON.stringify(r.body, null, 2)) + '</pre>' +
          '</div>'
        ).join('');
      } catch (e) {
        console.error('Failed to load raw requests:', e);
      }
    }

    let currentTaskFilter = '';

    window.setTaskFilter = function(btn, source) {
      document.querySelectorAll('.task-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTaskFilter = source;
      loadTaskAnalysis();
    };

    window.toggleTaskDetail = function(rowEl) {
      const detailRow = rowEl.nextElementSibling;
      if (detailRow && detailRow.classList.contains('task-detail-row')) {
        detailRow.classList.toggle('open');
      }
    };

    function renderRateBar(rate) {
      const color = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--yellow)' : 'var(--red)';
      const cls = rate >= 80 ? 'success' : rate >= 50 ? 'warn' : 'failure';
      return '<div class="rate-bar">' +
        '<span class="' + cls + '" style="font-weight:700;font-size:0.9rem;min-width:36px;">' + rate + '%</span>' +
        '<div class="rate-bar-track"><div class="rate-bar-fill" style="width:' + rate + '%;background:' + color + ';"></div></div>' +
        '</div>';
    }

    function renderSourcePips(bySource) {
      if (!bySource || Object.keys(bySource).length === 0) return '<span style="color:var(--muted);">-</span>';
      const order = ['eval', 'competition', 'manual'];
      const colors = { eval: 'var(--blue)', competition: 'var(--purple)', manual: 'var(--muted)' };
      const bgs = { eval: 'rgba(59,130,246,0.12)', competition: 'rgba(168,85,247,0.12)', manual: 'rgba(139,143,163,0.12)' };
      return '<div class="source-pips">' +
        order.filter(s => bySource[s]).map(s => {
          const d = bySource[s];
          return '<span class="source-pip" style="background:' + bgs[s] + ';color:' + colors[s] + ';" title="' + s + ': ' + d.passed + '/' + d.total + ' ok">' + d.passed + '/' + d.total + '</span>';
        }).join('') +
        '</div>';
    }

    async function loadTaskAnalysis() {
      try {
        const url = currentTaskFilter
          ? '/api/task-type-registry?source=' + currentTaskFilter
          : '/api/task-type-registry';
        const res = await fetch(url);
        const { registry, totals } = await res.json();

        document.getElementById('tasks-count').textContent = registry.length;

        const cardsEl = document.getElementById('task-summary-cards');
        cardsEl.innerHTML = [
          { label: 'Task Types', value: totals.types, cls: '' },
          { label: 'Dedicated', value: totals.dedicated, cls: 'success' },
          { label: 'Generic', value: totals.generic, cls: 'warn' },
          { label: 'With Evals', value: totals.withEvals + '/' + totals.types, cls: 'info' },
          { label: 'Eval Cases', value: totals.totalEvalCases, cls: 'info' },
          { label: 'Total Solves', value: totals.totalSolves, cls: '' },
        ].map(c => '<div class="task-summary-card"><div class="tsc-label">' + c.label + '</div><div class="tsc-value ' + c.cls + '">' + c.value + '</div></div>').join('');

        const body = document.getElementById('tasks-body');
        if (registry.length === 0) {
          body.innerHTML = '<tr><td colspan="9" class="empty-state">No task types found.</td></tr>';
          return;
        }

        body.innerHTML = registry.map(r => {
          const s = r.solves;
          const rate = s.total > 0 ? Math.round((s.passed / s.total) * 100) : -1;
          const rateHtml = rate >= 0 ? renderRateBar(rate) : '<span style="color:var(--muted);">-</span>';

          const handlerBadge = '<span class="handler-badge ' + r.handlerType + '">' + r.handlerType + '</span>';
          const evalBadge = '<span class="eval-count ' + (r.evalCases > 0 ? 'has-evals' : 'no-evals') + '">' + r.evalCases + '</span>';

          const mainRow = '<tr style="cursor:pointer;" onclick="toggleTaskDetail(this)">' +
            '<td><span class="mono" style="font-weight:600;">' + esc(r.taskType) + '</span></td>' +
            '<td>' + handlerBadge + '</td>' +
            '<td style="text-align:center;">' + evalBadge + '</td>' +
            '<td class="mono">' + (s.total > 0 ? '<span class="success">' + s.passed + '</span> / <span class="failure">' + s.failed + '</span>' : '<span style="color:var(--muted);">0</span>') + '</td>' +
            '<td>' + rateHtml + '</td>' +
            '<td class="mono" style="text-align:center;">' + (s.total > 0 ? s.avgCalls : '-') + '</td>' +
            '<td class="mono' + (s.avgErrors > 0 ? ' failure' : '') + '" style="text-align:center;">' + (s.total > 0 ? s.avgErrors : '-') + '</td>' +
            '<td class="mono" style="text-align:center;">' + (s.total > 0 ? (s.avgMs / 1000).toFixed(1) + 's' : '-') + '</td>' +
            '<td>' + renderSourcePips(s.bySource) + '</td>' +
            '</tr>';

          const detailRow = '<tr class="task-detail-row"><td colspan="9"><div class="task-detail-content">' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">' +
            '<div>' +
            '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:4px;">Description</div>' +
            '<div style="font-size:0.85rem;">' + esc(r.description) + '</div>' +
            '</div>' +
            '<div>' +
            '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:4px;">Handler</div>' +
            '<div style="font-size:0.85rem;">' + handlerBadge +
            (r.handlerFile ? ' <span class="mono" style="color:var(--muted);font-size:0.78rem;margin-left:6px;">src/handlers/' + esc(r.handlerFile) + '</span>' : ' <span class="mono" style="color:var(--muted);font-size:0.78rem;margin-left:6px;">generic-handler.ts</span>') +
            '</div>' +
            '<div style="margin-top:10px;">' +
            '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:4px;">Solve breakdown by source</div>' +
            (Object.keys(s.bySource || {}).length > 0
              ? Object.entries(s.bySource).map(([src, d]) => {
                  const srcRate = d.total > 0 ? Math.round((d.passed / d.total) * 100) : 0;
                  return '<div style="display:flex;gap:8px;align-items:center;font-size:0.8rem;margin:3px 0;">' +
                    '<span class="badge ' + (src === 'competition' ? 'comp' : src === 'eval' ? 'eval' : 'manual') + '" style="min-width:80px;text-align:center;">' + esc(src) + '</span>' +
                    '<span class="mono">' + d.passed + '/' + d.total + '</span>' +
                    '<span class="' + (srcRate >= 80 ? 'success' : srcRate >= 50 ? 'warn' : 'failure') + '" style="font-weight:600;">' + srcRate + '%</span>' +
                    '</div>';
                }).join('')
              : '<span style="color:var(--muted);font-size:0.8rem;">No solves yet</span>'
            ) +
            '</div>' +
            '</div></div>' +
            '</div></td></tr>';

          return mainRow + detailRow;
        }).join('');
      } catch (e) {
        console.error('Failed to load task analysis:', e);
      }
    }

    async function loadInitial() {
      const [statsRes, solvesRes] = await Promise.all([fetch('/api/stats'), fetch('/api/solves')]);
      const stats = await statsRes.json();
      allSolves = await solvesRes.json();

      renderStats(stats);
      refreshTables();
      loadRawRequests();
      loadTaskAnalysis();
    }

    function connectSSE() {
      const evtSource = new EventSource('/api/stream');
      evtSource.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'solve') {
          allSolves.unshift(msg.data);
          refreshTables();
          fetch('/api/stats').then(r => r.json()).then(renderStats);
          if (msg.data.source === 'competition') {
            switchTab('competition');
          }
          loadRawRequests();
          loadTaskAnalysis();
        }
      };
      evtSource.onerror = () => {
        connStatus.innerHTML = '<span class="badge err">DISCONNECTED</span>';
        setTimeout(() => connStatus.innerHTML = '<span class="badge live">RECONNECTING</span>', 1000);
      };
      evtSource.onopen = () => {
        connStatus.innerHTML = '<span class="badge live">LIVE</span>';
      };
    }

    loadInitial();
    connectSSE();
  </script>
</body>
</html>`;

console.log(`Dashboard starting on http://localhost:${PORT}`);
console.log(`Open in browser to monitor solve activity in real-time.\n`);

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`Dashboard running at http://localhost:${PORT}`);
