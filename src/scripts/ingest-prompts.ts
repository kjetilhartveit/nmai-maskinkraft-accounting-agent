import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { config } from "../lib/config.js";
import type { TestCase } from "../eval/types.js";
import { testCases as existingCases } from "../eval/test-cases.js";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.openrouter.apiKey,
  compatibility: "compatible",
});

const PROMPTS_FILE = join(import.meta.dirname, "../../data/solve-logs/prompts.jsonl");
const CANDIDATES_DIR = join(import.meta.dirname, "../../data/eval-candidates");

interface LoggedPrompt {
  id: string;
  timestamp: string;
  prompt: string;
  taskTypes: string[];
  taskCount: number;
  language: string;
  entities: Record<string, unknown>[];
  success: boolean;
  source: string;
}

const CandidateSchema = z.object({
  id: z.string(),
  language: z.string(),
  tier: z.number().min(1).max(3),
  taskType: z.string(),
  taskTypeAlternatives: z.array(z.string()).optional(),
  expectedEntities: z.array(z.record(z.unknown())),
  expectedTaskSequence: z
    .array(
      z.object({
        taskType: z.string(),
        entities: z.array(z.record(z.unknown())),
      }),
    )
    .optional(),
  optimalApiCalls: z.array(
    z.object({
      method: z.string(),
      endpoint: z.string(),
      notes: z.string(),
    }),
  ),
  optimalCallCount: z.number(),
  notes: z.string(),
});

const ANALYSIS_PROMPT = `You are an expert at the Tripletex accounting API. Given an accounting task prompt, produce a test case specification.

Known task types: create_employee, update_employee, create_customer, update_customer, create_product, create_department, create_invoice, send_invoice, create_payment, create_credit_note, create_order, create_travel_expense, delete_travel_expense, create_project, create_voucher, create_supplier.

For each prompt, determine:
1. A short kebab-case id (e.g. "employee-anna-en", "multi-customer-invoice-no")
2. The prompt language (en, no, fr, de, pt, es)
3. Scoring tier: 1 = simple single entity, 2 = multiple entities or less common type, 3 = complex multi-step
4. Primary task type
5. Alternative acceptable task types (if any)
6. Expected entities with their field values (English field names)
7. If multi-task: the expected task sequence with each task's type and entities
8. The optimal set of Tripletex API calls (fewest possible, using batch /list endpoints when creating multiple entities)
9. The optimal call count
10. Notes about edge cases or important details

Use batch endpoints (e.g. /department/list, /customer/list, /employee/list, /supplier/list) when creating multiple entities of the same type.
Dependencies: departments before employees, customers before orders/invoices, orders before invoices, employees before travel expenses.`;

async function analyzePrompt(
  prompt: string,
  model: string,
): Promise<z.infer<typeof CandidateSchema>> {
  const { object } = await generateObject({
    model: openrouter(model),
    schema: CandidateSchema,
    system: ANALYSIS_PROMPT,
    prompt: `Analyze this accounting task prompt and produce a test case specification:\n\n"${prompt}"`,
  });
  return object;
}

function loadLoggedPrompts(): LoggedPrompt[] {
  if (!existsSync(PROMPTS_FILE)) {
    console.log(`No prompts file found at ${PROMPTS_FILE}`);
    return [];
  }
  const lines = readFileSync(PROMPTS_FILE, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as LoggedPrompt);
}

function isAlreadyCovered(prompt: string): boolean {
  const normPrompt = prompt.trim().toLowerCase();
  return existingCases.some(
    (tc) => tc.prompt.trim().toLowerCase() === normPrompt,
  );
}

async function main() {
  if (!existsSync(CANDIDATES_DIR)) {
    mkdirSync(CANDIDATES_DIR, { recursive: true });
  }

  const args = process.argv.slice(2).filter((a) => a !== "--");
  const model = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? config.openrouter.model;
  const sourceFilter = args.find((a) => a.startsWith("--source="))?.split("=")[1];
  const dryRun = args.includes("--dry-run");

  const logged = loadLoggedPrompts();
  if (logged.length === 0) {
    console.log("No logged prompts to ingest. Run some solves first.");
    return;
  }

  const filtered = sourceFilter
    ? logged.filter((p) => p.source === sourceFilter)
    : logged;

  const novel = filtered.filter((p) => !isAlreadyCovered(p.prompt));

  console.log(`Found ${logged.length} logged prompts, ${novel.length} novel (not in existing test cases)`);

  if (novel.length === 0) {
    console.log("All prompts are already covered by existing test cases.");
    return;
  }

  const seen = new Set<string>();
  const unique = novel.filter((p) => {
    const key = p.prompt.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Analyzing ${unique.length} unique prompts with ${model}...\n`);

  const candidates: Array<{ prompt: string; analysis: z.infer<typeof CandidateSchema> }> = [];

  for (const entry of unique) {
    if (dryRun) {
      console.log(`[DRY RUN] Would analyze: "${entry.prompt.slice(0, 80)}..."`);
      continue;
    }

    try {
      console.log(`Analyzing: "${entry.prompt.slice(0, 80)}..."`);
      const analysis = await analyzePrompt(entry.prompt, model);
      candidates.push({ prompt: entry.prompt, analysis });
      console.log(`  → id: ${analysis.id}, tier: ${analysis.tier}, type: ${analysis.taskType}, optimal calls: ${analysis.optimalCallCount}`);
    } catch (err) {
      console.error(`  → Error analyzing prompt: ${(err as Error).message}`);
    }
  }

  if (candidates.length === 0) {
    console.log("\nNo candidates generated.");
    return;
  }

  const outFile = join(CANDIDATES_DIR, `candidates-${Date.now()}.json`);
  const output = {
    generatedAt: new Date().toISOString(),
    model,
    reviewStatus: "pending_human_review",
    candidates: candidates.map((c) => ({
      prompt: c.prompt,
      ...c.analysis,
    })),
  };

  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${candidates.length} candidate(s) to ${outFile}`);
  console.log("Review the candidates and move approved ones to src/eval/test-cases.ts");
}

main().catch(console.error);
