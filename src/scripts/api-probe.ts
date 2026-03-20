import { config } from "../lib/config.js";
import { TripletexClient } from "../lib/tripletex-client.js";
import * as readline from "node:readline";

const HELP = `
Tripletex API Probe — Direct sandbox endpoint validation
═════════════════════════════════════════════════════════

  One-shot mode:
    pnpm probe GET /employee
    pnpm probe GET /employee '{"from":"0","count":"5"}'
    pnpm probe POST /department '{"name":"Salg"}'
    pnpm probe PUT /department/123 '{"id":123,"version":0,"name":"Salg NY"}'
    pnpm probe DELETE /department/123

  Interactive REPL:
    pnpm probe
    > GET /employee
    > POST /department {"name":"Salg"}
    > GET /ledger/vatType {"from":"0","count":"100"}
    > PUT /department/5 {"id":5,"version":0,"name":"Ny avdeling"}
    > DELETE /department/5

  REPL commands:
    help          Show this help
    stats         Show API call statistics
    log           Show full call log
    last          Show last response again
    clear         Clear screen
    exit / quit   Exit the REPL
`.trim();

function createClient() {
  const { apiUrl, sessionToken } = config.sandbox;
  if (!apiUrl || !sessionToken) {
    console.error("Missing SANDBOX_API_URL or SANDBOX_SESSION_TOKEN in .env");
    process.exit(1);
  }
  console.log(`Connected to: ${apiUrl}\n`);
  return new TripletexClient(apiUrl, sessionToken);
}

function parseCliArgs(): { method: string; endpoint: string; data?: unknown } | null {
  const [, , method, endpoint, dataStr] = process.argv;
  if (!method) return null;
  if (method === "--help" || method === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const m = method.toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE"].includes(m)) {
    console.error(`Unknown method: ${method}. Use GET, POST, PUT, or DELETE.`);
    process.exit(1);
  }
  if (!endpoint) {
    console.error("Missing endpoint. Usage: pnpm probe GET /employee");
    process.exit(1);
  }

  let data: unknown;
  if (dataStr) {
    try {
      data = JSON.parse(dataStr);
    } catch {
      console.error(`Invalid JSON: ${dataStr}`);
      process.exit(1);
    }
  }

  return { method: m, endpoint, data };
}

function parseInput(line: string): { method: string; endpoint: string; data?: unknown } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(GET|POST|PUT|DELETE)\s+(\/\S+)\s*(.*)?$/i);
  if (!match) return null;

  const method = match[1].toUpperCase();
  const endpoint = match[2];
  let data: unknown;

  if (match[3]?.trim()) {
    try {
      data = JSON.parse(match[3].trim());
    } catch {
      console.error(`  Invalid JSON: ${match[3].trim()}`);
      return null;
    }
  }

  return { method, endpoint, data };
}

async function executeCall(
  client: TripletexClient,
  method: string,
  endpoint: string,
  data?: unknown,
): Promise<unknown> {
  switch (method) {
    case "GET": {
      const params = data as Record<string, string> | undefined;
      const isIdPath = /\/\d+$/.test(endpoint) || /\/\d+\/\w+$/.test(endpoint);
      if (isIdPath) {
        return client.get<unknown>(endpoint, params);
      }
      return client.list<unknown>(endpoint, params);
    }
    case "POST": {
      if (Array.isArray(data)) {
        return client.postList<unknown>(endpoint, data);
      }
      return client.post<unknown>(endpoint, data ?? {});
    }
    case "PUT": {
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return client.put<unknown>(endpoint, data);
      }
      // Action-style PUT with query params (for :action endpoints)
      const params = data as Record<string, string> | undefined;
      if (params) {
        const qs = new URLSearchParams(params).toString();
        return client.put<unknown>(`${endpoint}?${qs}`, undefined);
      }
      return client.put<unknown>(endpoint, undefined);
    }
    case "DELETE":
      await client.delete(endpoint);
      return { deleted: true };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function printResult(result: unknown): void {
  const json = JSON.stringify(result, null, 2);
  const lines = json.split("\n");

  if (lines.length > 120) {
    const preview = lines.slice(0, 80).join("\n");
    console.log(preview);
    console.log(`  ... (${lines.length - 80} more lines, ${json.length} chars total)`);
    console.log(lines.slice(-5).join("\n"));
  } else {
    console.log(json);
  }
}

async function runOnce(client: TripletexClient, method: string, endpoint: string, data?: unknown) {
  console.log(`${method} ${endpoint}${data ? " " + JSON.stringify(data) : ""}\n`);
  try {
    const result = await executeCall(client, method, endpoint, data);
    printResult(result);
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`\nStats: ${JSON.stringify(client.stats)}`);
}

async function runRepl(client: TripletexClient) {
  console.log(HELP);
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "probe> ",
  });

  let lastResult: unknown = null;

  rl.prompt();

  rl.on("line", async (line: string) => {
    const cmd = line.trim().toLowerCase();

    if (cmd === "exit" || cmd === "quit") {
      console.log(`\nFinal stats: ${JSON.stringify(client.stats)}`);
      rl.close();
      return;
    }
    if (cmd === "help") {
      console.log(HELP);
      rl.prompt();
      return;
    }
    if (cmd === "stats") {
      console.log(JSON.stringify(client.stats, null, 2));
      rl.prompt();
      return;
    }
    if (cmd === "log") {
      for (const call of client.calls) {
        const status = call.isError ? `${call.status} ERROR` : `${call.status}`;
        console.log(`  ${call.method.padEnd(6)} ${call.endpoint} → ${status} (${call.durationMs}ms)`);
      }
      if (client.calls.length === 0) console.log("  (no calls yet)");
      rl.prompt();
      return;
    }
    if (cmd === "last") {
      if (lastResult) printResult(lastResult);
      else console.log("  (no previous result)");
      rl.prompt();
      return;
    }
    if (cmd === "clear") {
      console.clear();
      rl.prompt();
      return;
    }

    const parsed = parseInput(line);
    if (!parsed) {
      if (line.trim()) console.log('  Unknown command. Type "help" or use: METHOD /endpoint [json]');
      rl.prompt();
      return;
    }

    try {
      const result = await executeCall(client, parsed.method, parsed.endpoint, parsed.data);
      lastResult = result;
      printResult(result);
    } catch (err) {
      console.error(`  ERROR: ${err instanceof Error ? err.message : err}`);
    }

    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

async function main() {
  const args = parseCliArgs();
  const client = createClient();

  if (args) {
    await runOnce(client, args.method, args.endpoint, args.data);
  } else {
    await runRepl(client);
  }
}

main().catch(console.error);
