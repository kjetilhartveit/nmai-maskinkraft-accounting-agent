import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dirname, "../../data");
const SOLVES_FILE = join(DATA_DIR, "solve-logs/solves.jsonl");
const RAW_REQUESTS_FILE = join(DATA_DIR, "solve-logs/raw-requests.jsonl");
const PROMOTED_FILE = join(DATA_DIR, "verified/promoted-test-cases.json");

const PORT = 3001;

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

function loadJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function loadSolves(): SolveEntry[] {
  return loadJsonl<SolveEntry>(SOLVES_FILE);
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
  let solves = loadSolves();
  if (source) solves = solves.filter(s => s.source === source);
  return c.json(solves.reverse());
});

app.get("/api/raw-requests", (c) => {
  const raws = loadJsonl<Record<string, unknown>>(RAW_REQUESTS_FILE);
  return c.json(raws.reverse());
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
      lastSolve: compSolves.length > 0 ? compSolves[compSolves.length - 1] : null,
    },
    totalApiCalls: totalCalls,
    totalApiErrors: totalErrors,
    promotedTestCases: promoted,
    lastSolve: solves.length > 0 ? solves[solves.length - 1] : null,
  });
});

app.get("/api/stream", (c) => {
  let lastCount = loadSolves().length;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: "connected", solveCount: lastCount });

      const interval = setInterval(() => {
        const solves = loadSolves();
        if (solves.length > lastCount) {
          const newSolves = solves.slice(lastCount);
          for (const solve of newSolves) {
            send({ type: "solve", data: solve });
          }
          lastCount = solves.length;
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

    async function loadInitial() {
      const [statsRes, solvesRes] = await Promise.all([fetch('/api/stats'), fetch('/api/solves')]);
      const stats = await statsRes.json();
      allSolves = await solvesRes.json();

      renderStats(stats);
      refreshTables();
      loadRawRequests();
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
