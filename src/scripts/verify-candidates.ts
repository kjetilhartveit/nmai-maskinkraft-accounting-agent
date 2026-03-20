import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
// Archived: OpenRouter + Vercel AI SDK
// import { createOpenAI } from "@ai-sdk/openai";
// import { generateObject } from "ai";
// const openrouter = createOpenAI({ ... });
import { z } from "zod";
import { config } from "../lib/config.js";
import { geminiGenerateStructured } from "../lib/gemini.js";
import { testCases as existingCases } from "../eval/test-cases.js";
import type { TestCase } from "../eval/types.js";
import type { TaskType } from "../types/index.js";

const CANDIDATES_DIR = join(import.meta.dirname, "../../data/eval-candidates");
const VERIFIED_DIR = join(import.meta.dirname, "../../data/verified");
const PROMOTED_FILE = join(VERIFIED_DIR, "promoted-test-cases.json");

interface CandidateFile {
  generatedAt: string;
  model: string;
  reviewStatus: string;
  candidates: CandidateEntry[];
}

interface CandidateEntry {
  prompt: string;
  id: string;
  language: string;
  tier: number;
  taskType: string;
  taskTypeAlternatives?: string[];
  expectedEntities: Record<string, unknown>[];
  expectedTaskSequence?: { taskType: string; entities: Record<string, unknown>[] }[];
  optimalApiCalls: { method: string; endpoint: string; notes: string }[];
  optimalCallCount: number;
  notes: string;
}

const VerificationSchema = z.object({
  taskType: z.string(),
  taskTypeAlternatives: z.array(z.string()).optional(),
  expectedEntities: z.array(z.record(z.unknown())),
  expectedTaskSequence: z.array(z.object({
    taskType: z.string(),
    entities: z.array(z.record(z.unknown())),
  })).optional(),
  optimalCallCount: z.number(),
  tier: z.number().min(1).max(3),
  language: z.string(),
  agreement: z.enum(["agree", "disagree", "partial"]),
  disagreementDetails: z.string().optional(),
  correctedFields: z.record(z.unknown()).optional(),
});

const VERIFY_PROMPT = `You are a senior Tripletex API expert providing a second opinion on test case specifications.

Given an accounting task prompt and a proposed specification, independently verify:
1. Is the task type correct?
2. Are the expected entities and their fields accurate?
3. Is the task sequence (if multi-step) in the right order?
4. Is the optimal API call count reasonable?
5. Is the tier rating appropriate?
6. Is the language detection correct?

Return your own independent analysis AND whether you agree with the original.
- "agree": the specification is correct as-is
- "partial": mostly correct but some fields need adjustment
- "disagree": significant errors in the specification

If partial or disagree, explain what's wrong in disagreementDetails and provide corrected values in correctedFields.

Known task types: create_employee, update_employee, create_customer, update_customer, create_product, create_department, create_invoice, send_invoice, create_payment, create_credit_note, create_order, create_travel_expense, delete_travel_expense, create_project, create_voucher, create_supplier.

Tripletex batch endpoints: /department/list, /customer/list, /employee/list, /supplier/list — use these when creating multiple entities of the same type (count as 1 API call).

Dependencies: departments before employees, customers before orders/invoices, orders before invoices.`;

async function verifyCandidate(
  prompt: string,
  candidate: CandidateEntry,
  model: string,
): Promise<z.infer<typeof VerificationSchema>> {
  const { object } = await geminiGenerateStructured({
    model,
    schema: VerificationSchema,
    system: VERIFY_PROMPT + `\n\nRespond with valid JSON matching: { taskType, taskTypeAlternatives?, expectedEntities, expectedTaskSequence?, optimalCallCount, tier, language, agreement: "agree"|"disagree"|"partial", disagreementDetails?, correctedFields? }`,
    prompt: `Verify this test case specification:

PROMPT: "${prompt}"

PROPOSED SPECIFICATION:
- Task type: ${candidate.taskType}
- Alternatives: ${candidate.taskTypeAlternatives?.join(", ") ?? "none"}
- Tier: ${candidate.tier}
- Language: ${candidate.language}
- Entities: ${JSON.stringify(candidate.expectedEntities)}
- Task sequence: ${JSON.stringify(candidate.expectedTaskSequence ?? "N/A")}
- Optimal call count: ${candidate.optimalCallCount}
- Optimal calls: ${JSON.stringify(candidate.optimalApiCalls)}
- Notes: ${candidate.notes}`,
  });
  return object;
}

function candidateToTestCase(
  candidate: CandidateEntry,
  verification: z.infer<typeof VerificationSchema>,
): TestCase {
  const useVerified = verification.agreement !== "agree";

  const taskType = (useVerified ? verification.taskType : candidate.taskType) as TaskType;
  const alts = useVerified
    ? verification.taskTypeAlternatives
    : candidate.taskTypeAlternatives;

  const entities = useVerified
    ? verification.expectedEntities
    : candidate.expectedEntities;

  const sequence = useVerified
    ? verification.expectedTaskSequence
    : candidate.expectedTaskSequence;

  const tier = (useVerified ? verification.tier : candidate.tier) as 1 | 2 | 3;
  const optimalCount = useVerified ? verification.optimalCallCount : candidate.optimalCallCount;
  const language = useVerified ? verification.language : candidate.language;

  const tc: TestCase = {
    id: candidate.id,
    prompt: candidate.prompt,
    language,
    tier,
    taskType,
    expectedEntities: entities,
    expectedApiCalls: { max: optimalCount * 4, maxErrors: tier === 1 ? 0 : 2 },
  };

  if (alts && alts.length > 0) {
    tc.taskTypeAlternatives = alts as TaskType[];
  }

  if (sequence && sequence.length > 0) {
    tc.expectedTaskSequence = sequence.map(s => ({
      taskType: s.taskType as TaskType,
      entities: s.entities,
    }));
  }

  if (candidate.notes) {
    tc.notes = candidate.notes;
  }

  return tc;
}

function loadExistingPromoted(): TestCase[] {
  if (!existsSync(PROMOTED_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PROMOTED_FILE, "utf-8")) as TestCase[];
  } catch {
    return [];
  }
}

function isAlreadyPromoted(id: string, existingPromoted: TestCase[]): boolean {
  return existingCases.some(tc => tc.id === id) || existingPromoted.some(tc => tc.id === id);
}

async function main() {
  if (!existsSync(CANDIDATES_DIR)) {
    console.log("No candidates directory found. Run `pnpm ingest` first.");
    return;
  }

  const args = process.argv.slice(2);
  const model = args.find(a => a.startsWith("--model="))?.split("=")[1] ?? config.google.model;
  const dryRun = args.includes("--dry-run");
  const autoPromote = !args.includes("--no-promote");

  const candidateFiles = readdirSync(CANDIDATES_DIR).filter(f => f.endsWith(".json"));
  if (candidateFiles.length === 0) {
    console.log("No candidate files found. Run `pnpm ingest` first.");
    return;
  }

  console.log(`=== LLM Verification ===\n`);
  console.log(`Model: ${model}`);
  console.log(`Auto-promote: ${autoPromote}`);
  console.log(`Candidate files: ${candidateFiles.length}\n`);

  const existingPromoted = loadExistingPromoted();
  const promoted: TestCase[] = [];
  const flagged: { candidate: CandidateEntry; reason: string }[] = [];

  for (const file of candidateFiles) {
    const filePath = join(CANDIDATES_DIR, file);
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as CandidateFile;

    if (data.reviewStatus === "verified") {
      console.log(`Skipping ${file} (already verified)`);
      continue;
    }

    console.log(`Processing ${file} (${data.candidates.length} candidates)...`);

    for (const candidate of data.candidates) {
      if (isAlreadyPromoted(candidate.id, existingPromoted)) {
        console.log(`  ⏭ ${candidate.id}: already in test cases`);
        continue;
      }

      if (dryRun) {
        console.log(`  [DRY RUN] Would verify: ${candidate.id}`);
        continue;
      }

      try {
        console.log(`  Verifying: ${candidate.id}...`);
        const verification = await verifyCandidate(candidate.prompt, candidate, model);

        if (verification.agreement === "agree" || verification.agreement === "partial") {
          const tc = candidateToTestCase(candidate, verification);
          promoted.push(tc);
          const tag = verification.agreement === "agree" ? "✓" : "~";
          console.log(`  ${tag} ${candidate.id}: ${verification.agreement} → promoted`);
          if (verification.disagreementDetails) {
            console.log(`    Adjustments: ${verification.disagreementDetails}`);
          }
        } else {
          flagged.push({ candidate, reason: verification.disagreementDetails ?? "Disagreement" });
          console.log(`  ✗ ${candidate.id}: disagreement → flagged for review`);
          console.log(`    Reason: ${verification.disagreementDetails}`);
        }
      } catch (err) {
        console.error(`  ✗ ${candidate.id}: error — ${(err as Error).message}`);
      }
    }

    if (!dryRun) {
      data.reviewStatus = "verified";
      writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
  }

  if (promoted.length > 0 && autoPromote) {
    const allPromoted = [...existingPromoted, ...promoted];
    if (!existsSync(VERIFIED_DIR)) mkdirSync(VERIFIED_DIR, { recursive: true });
    writeFileSync(PROMOTED_FILE, JSON.stringify(allPromoted, null, 2));
    console.log(`\nPromoted ${promoted.length} test case(s) → ${PROMOTED_FILE}`);
  }

  if (flagged.length > 0) {
    console.log(`\n⚠ ${flagged.length} candidate(s) flagged for manual review:`);
    for (const f of flagged) {
      console.log(`  - ${f.candidate.id}: ${f.reason}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Promoted: ${promoted.length}`);
  console.log(`Flagged: ${flagged.length}`);
  console.log(`Total test cases: ${existingCases.length + existingPromoted.length + promoted.length}`);
}

main().catch(console.error);
