#!/usr/bin/env tsx
/**
 * Test the solve flow (classifier → extractor → handlers).
 *
 * Usage:
 *   pnpm test-pipeline                    # Run with sample prompts
 *   pnpm test-pipeline "your prompt"      # Run with custom prompt
 *   pnpm test-pipeline --verbose          # Show detailed reasoning
 */
import "dotenv/config";
import { classifyPrompt } from "../lib/task-classifier.js";
import { extractEntities, buildTaskSequence } from "../lib/entity-extractor.js";
import { createSolveTrace } from "../lib/solve-trace.js";
import type { TaskType } from "../types/index.js";

const SAMPLE_PROMPTS = [
  "Opprett en ny avdeling kalt Økonomi",
  "Create customer Acme AS with org number 123456789",
  "Registrer leverandøren Elvdal AS med organisasjonsnummer 994963309. E-post: faktura@elvdal.no",
  "Kjør lønn for Erik Nilsen (erik.nilsen@example.org). Grunnlønn 53350 kr. Bonus 11050 kr.",
  "Create a custom accounting dimension called Region with values Nord-Norge and Vestlandet",
];

async function testPipeline(prompt: string, options: { verbose?: boolean }) {
  const solveId = `test-${Date.now()}`;
  const trace = createSolveTrace(solveId);

  console.log("\n" + "=".repeat(80));
  console.log(`PROMPT: ${prompt}`);
  console.log("=".repeat(80));

  // Log request
  trace.logRequest(prompt, 0, "test");

  // Step 1: Classify
  console.log("\n[1] CLASSIFYING...");
  const classifyStart = performance.now();
  const classification = await classifyPrompt(prompt);
  const classifyMs = Math.round(performance.now() - classifyStart);

  if (!classification) {
    console.log("   Classification failed!");
    trace.logResult(false, { total: 0, errors: 0 }, "Classification failed");
    return;
  }

  console.log(`   Type: ${classification.type}`);
  console.log(`   Method: ${classification.method}`);
  console.log(`   Duration: ${classifyMs}ms`);

  const taskType = classification.type as TaskType;
  trace.logClassification(taskType, classification.method, undefined, classifyMs);

  // Step 2: Extract entities
  console.log("\n[2] EXTRACTING ENTITIES...");
  const extraction = await extractEntities(taskType, prompt, []);

  console.log(`   Language: ${extraction.language}`);
  console.log(`   Duration: ${extraction.durationMs}ms`);
  console.log(`   Entities: ${JSON.stringify(extraction.entities, null, 2)}`);

  trace.logEntityExtraction(taskType, extraction.entities, extraction.durationMs);

  if (extraction.prerequisites.length > 0) {
    console.log(`   Prerequisites: ${extraction.prerequisites.map(p => p.taskType).join(", ")}`);
  }

  // Step 3: Build task sequence
  console.log("\n[3] BUILDING TASK SEQUENCE...");
  const tasks = buildTaskSequence(taskType, extraction, prompt);

  console.log(`   Tasks: ${tasks.map(t => t.taskType).join(" → ")}`);
  trace.logTaskSequence(
    tasks.map(t => ({ taskType: t.taskType, entities: t.entities })),
    extraction.language,
  );

  trace.logResult(true, { total: 0, errors: 0 });
  console.log("\n[DONE] Check logs at:", trace.dir);
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");

  // Filter out flags to get prompts
  const prompts = args.filter(a => !a.startsWith("--") && !a.startsWith("-"));

  if (prompts.length > 0) {
    // Run with provided prompts
    for (const prompt of prompts) {
      await testPipeline(prompt, { verbose });
    }
  } else {
    // Run with sample prompts
    console.log("Running with sample prompts (pass a prompt as argument for custom)");
    console.log("Use --verbose for detailed reasoning output\n");

    for (const prompt of SAMPLE_PROMPTS) {
      await testPipeline(prompt, { verbose });
    }
  }
}

main().catch(console.error);
