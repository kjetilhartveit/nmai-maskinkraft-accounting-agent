import "dotenv/config";
import { config } from "../lib/config.js";
import { testCases } from "../eval/test-cases.js";
import { runEval, summarize } from "../eval/runner.js";
import { printEvalTable } from "../eval/reporter.js";
import type { EvalConfig } from "../eval/types.js";

function parseArgs(argv: string[]): {
  model?: string;
  systemPromptVariant?: string;
  description?: string;
  serverUrl?: string;
  iterations?: number;
  filter?: string;
} {
  const out: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) {
      out.model = argv[++i];
    } else if (a === "--system-prompt-variant" && argv[i + 1]) {
      out.systemPromptVariant = argv[++i];
    } else if (a === "--description" && argv[i + 1]) {
      out.description = argv[++i];
    } else if (a === "--server" && argv[i + 1]) {
      out.serverUrl = argv[++i];
    } else if (a === "--iterations" && argv[i + 1]) {
      out.iterations = parseInt(argv[++i], 10);
    } else if (a === "--filter" && argv[i + 1]) {
      out.filter = argv[++i];
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2).filter((x) => x !== "--");
  const args = parseArgs(argv);

  const evalConfig: EvalConfig = {
    model: args.model ?? config.openrouter.model,
    ...(args.systemPromptVariant
      ? { systemPromptVariant: args.systemPromptVariant }
      : {}),
    ...(args.description ? { description: args.description } : {}),
  };

  let cases = testCases;
  if (args.filter) {
    cases = cases.filter(
      (tc) =>
        tc.id.includes(args.filter!) ||
        tc.taskType.includes(args.filter!) ||
        tc.prompt.toLowerCase().includes(args.filter!.toLowerCase()),
    );
  }

  const iterations = args.iterations ?? 1;
  const serverUrl = args.serverUrl ?? process.env.SERVER_URL ?? "http://localhost:3000";

  console.log(`Evaluating ${cases.length} case(s) × ${iterations} iteration(s) (server: ${serverUrl})`);
  console.log(`Model: ${evalConfig.model}${evalConfig.systemPromptVariant ? ` | system prompt variant: ${evalConfig.systemPromptVariant}` : ""}`);

  const results = await runEval(evalConfig, cases, {
    serverUrl: args.serverUrl,
    iterations,
  });
  const summary = summarize(results);
  printEvalTable(results, summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
