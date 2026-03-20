import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync, watchFile } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dirname, "../../data");
const SOLVES_FILE = join(DATA_DIR, "solve-logs/solves.jsonl");
const PROMPTS_FILE = join(DATA_DIR, "solve-logs/prompts.jsonl");
const PROMOTED_FILE = join(DATA_DIR, "verified/promoted-test-cases.json");

const PORT = 3001;

interface SolveEntry {
  id: string;
  timestamp: string;
  prompt: string;
  filesCount: number;
  baseUrl: string;
  parsedSequence?: { tasks: { taskType: string; entities: Record<string, unknown>[] }[]; language: string };
  apiCalls: { method: string; endpoint: string; status: number; durationMs: number; isError: boolean }[];
  apiCallStats: { total: number; errors: number; totalDuration: number };
  elapsedMs: number;
  success: boolean;
  error?: string;
  source: string;
}

function loadSolves(): SolveEntry[] {
  if (!existsSync(SOLVES_FILE)) return [];
  try {
    return readFileSync(SOLVES_FILE, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function loadPromoted(): number {
  if (!existsSync(PROMOTED_FILE)) return 0;
  try {
    return (JSON.parse(readFileSync(PROMOTED_FILE, "utf-8")) as unknown[]).length;
  } catch { return 0; }
}

const app = new Hono();

app.get("/api/solves", (c) => {
  const solves = loadSolves();
  return c.json(solves.reverse());
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

  return c.json({
    totalSolves: solves.length,
    successes,
    failures: solves.length - successes,
    successRate: solves.length > 0 ? Math.round((successes / solves.length) * 100) : 0,
    bySource,
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
    :root { --bg: #0f1117; --card: #1a1d27; --border: #2a2d3a; --text: #e1e4eb; --muted: #8b8fa3; --green: #22c55e; --red: #ef4444; --yellow: #eab308; --blue: #3b82f6; --purple: #a855f7; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    .subtitle { color: var(--muted); font-size: 0.85rem; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .stat-card .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-card .value { font-size: 1.75rem; font-weight: 700; margin-top: 4px; }
    .stat-card .sub { color: var(--muted); font-size: 0.75rem; margin-top: 2px; }
    .success { color: var(--green); }
    .failure { color: var(--red); }
    .info { color: var(--blue); }
    .warn { color: var(--yellow); }
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
    .prompt-text { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .api-call { display: inline-flex; gap: 4px; align-items: center; margin: 2px 0; font-size: 0.75rem; }
    .api-call .method { font-weight: 600; min-width: 40px; }
    .api-call .endpoint { color: var(--muted); }
    .api-call .status-ok { color: var(--green); }
    .api-call .status-err { color: var(--red); }
    .expand-btn { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 0.7rem; }
    .expand-btn:hover { border-color: var(--text); color: var(--text); }
    .details { display: none; background: var(--bg); padding: 12px; border-radius: 6px; margin-top: 8px; font-size: 0.8rem; }
    .details.open { display: block; }
    .details pre { white-space: pre-wrap; word-break: break-all; color: var(--muted); }
    #connection-status { position: fixed; top: 12px; right: 20px; }
  </style>
</head>
<body>
  <div id="connection-status"><span class="badge live">LIVE</span></div>
  <h1>Accounting Agent Dashboard</h1>
  <p class="subtitle">Real-time monitoring for NM i AI — Tripletex Accounting Agent</p>

  <div class="grid" id="stats"></div>

  <div class="section">
    <h2>Recent Solves <span class="badge live">live</span></h2>
    <table>
      <thead><tr>
        <th>Time</th><th>Source</th><th>Status</th><th>Prompt</th><th>Tasks</th><th>API Calls</th><th>Errors</th><th>Duration</th><th></th>
      </tr></thead>
      <tbody id="solves-body"></tbody>
    </table>
  </div>

  <script>
    const statsEl = document.getElementById('stats');
    const tbody = document.getElementById('solves-body');
    const connStatus = document.getElementById('connection-status');

    function sourceBadge(source) {
      const cls = source === 'competition' ? 'comp' : source === 'eval' ? 'eval' : 'manual';
      return '<span class="badge ' + cls + '">' + source + '</span>';
    }

    function statusBadge(success) {
      return success ? '<span class="badge ok">OK</span>' : '<span class="badge err">FAIL</span>';
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function renderStats(data) {
      statsEl.innerHTML = [
        { label: 'Total Solves', value: data.totalSolves, cls: '' },
        { label: 'Success Rate', value: data.successRate + '%', cls: data.successRate >= 80 ? 'success' : data.successRate >= 50 ? 'warn' : 'failure', sub: data.successes + ' ok / ' + data.failures + ' fail' },
        { label: 'Competition', value: data.bySource.competition, cls: 'info' },
        { label: 'Eval', value: data.bySource.eval, cls: 'info' },
        { label: 'API Calls', value: data.totalApiCalls, cls: '', sub: data.totalApiErrors + ' errors' },
        { label: 'Test Cases', value: 9 + data.promotedTestCases, cls: 'info', sub: data.promotedTestCases + ' auto-promoted' },
      ].map(s => '<div class="stat-card"><div class="label">' + s.label + '</div><div class="value ' + s.cls + '">' + s.value + '</div>' + (s.sub ? '<div class="sub">' + s.sub + '</div>' : '') + '</div>').join('');
    }

    function renderSolveRow(solve) {
      const tasks = solve.parsedSequence?.tasks?.map(t => t.taskType).join(' → ') ?? '-';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' + formatTime(solve.timestamp) + '</td>' +
        '<td>' + sourceBadge(solve.source) + '</td>' +
        '<td>' + statusBadge(solve.success) + '</td>' +
        '<td class="prompt-text" title="' + solve.prompt.replace(/"/g, '&quot;') + '">' + solve.prompt.slice(0, 60) + (solve.prompt.length > 60 ? '…' : '') + '</td>' +
        '<td class="mono">' + tasks + '</td>' +
        '<td class="mono">' + (solve.apiCallStats?.total ?? 0) + '</td>' +
        '<td class="mono ' + ((solve.apiCallStats?.errors ?? 0) > 0 ? 'failure' : '') + '">' + (solve.apiCallStats?.errors ?? 0) + '</td>' +
        '<td class="mono">' + (solve.elapsedMs / 1000).toFixed(1) + 's</td>' +
        '<td><button class="expand-btn" onclick="toggleDetails(this)">details</button></td>';
      const detailRow = document.createElement('tr');
      detailRow.innerHTML = '<td colspan="9"><div class="details"><h4>API Calls:</h4>' +
        (solve.apiCalls || []).map(c =>
          '<div class="api-call"><span class="method">' + c.method + '</span> <span class="endpoint">' + c.endpoint + '</span> → <span class="' + (c.isError ? 'status-err' : 'status-ok') + '">' + c.status + '</span> <span class="mono">(' + c.durationMs + 'ms)</span></div>'
        ).join('') +
        (solve.error ? '<h4 style="margin-top:8px;color:var(--red)">Error:</h4><pre>' + solve.error + '</pre>' : '') +
        '<h4 style="margin-top:8px">Full prompt:</h4><pre>' + solve.prompt + '</pre>' +
        '</div></td>';
      return [tr, detailRow];
    }

    window.toggleDetails = function(btn) {
      const detailDiv = btn.closest('tr').nextElementSibling.querySelector('.details');
      detailDiv.classList.toggle('open');
      btn.textContent = detailDiv.classList.contains('open') ? 'hide' : 'details';
    };

    async function loadInitial() {
      const res = await fetch('/api/stats');
      const stats = await res.json();
      renderStats(stats);

      const solvesRes = await fetch('/api/solves');
      const solves = await solvesRes.json();
      for (const solve of solves.slice(0, 50)) {
        const [row, detail] = renderSolveRow(solve);
        tbody.appendChild(row);
        tbody.appendChild(detail);
      }
    }

    function connectSSE() {
      const evtSource = new EventSource('/api/stream');
      evtSource.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'solve') {
          const [row, detail] = renderSolveRow(msg.data);
          tbody.prepend(detail);
          tbody.prepend(row);
          row.style.background = 'rgba(59,130,246,0.08)';
          setTimeout(() => row.style.background = '', 2000);
          fetch('/api/stats').then(r => r.json()).then(renderStats);
        }
      };
      evtSource.onerror = () => {
        connStatus.innerHTML = '<span class="badge err">DISCONNECTED</span>';
        setTimeout(() => {
          connStatus.innerHTML = '<span class="badge live">RECONNECTING</span>';
        }, 1000);
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
