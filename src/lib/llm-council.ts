/**
 * LLM Council — Multi-LLM reasoning for complex/unknown tasks.
 *
 * When a task is classified as "unknown" or complex, we consult multiple LLMs:
 * 1. Each LLM reasons about how to solve the task
 * 2. Each suggests whether to use a built-in handler or custom approach
 * 3. An arbiter synthesizes the reasoning and makes a final decision
 * 4. The chosen approach is executed with full logging
 */

import { z } from "zod";
import { geminiGenerateStructured, type GeminiJsonSchema } from "./gemini.js";
import type { SolveTrace, LLMReasoning, CouncilDecision } from "./solve-trace.js";
import type { ParsedTask, TaskType } from "../types/index.js";
import { PROMPT_TEMPLATES } from "./task-classifier.js";

// ── Schemas ──────────────────────────────────────────────────────────

const ReasoningSchema = z.object({
  reasoning: z.string(),
  suggestedApproach: z.string(),
  suggestedTaskType: z.string().optional(),
  useBuiltInHandler: z.boolean(),
  confidence: z.number().min(0).max(1),
  apiEndpoints: z.array(z.string()).optional(),
  potentialIssues: z.array(z.string()).optional(),
});

const REASONING_JSON_SCHEMA: GeminiJsonSchema = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "Step-by-step reasoning about how to solve this task" },
    suggestedApproach: { type: "string", description: "The recommended approach to solve this task" },
    suggestedTaskType: { type: "string", description: "If a built-in handler should be used, which task type" },
    useBuiltInHandler: { type: "boolean", description: "Whether to use a built-in handler (true) or custom approach (false)" },
    confidence: { type: "number", description: "Confidence in the suggested approach (0-1)" },
    apiEndpoints: { type: "array", items: { type: "string" }, description: "API endpoints that might be needed" },
    potentialIssues: { type: "array", items: { type: "string" }, description: "Potential issues or challenges" },
  },
  required: ["reasoning", "suggestedApproach", "useBuiltInHandler", "confidence"],
};

const ArbiterSchema = z.object({
  finalDecision: z.enum(["builtin", "custom"]),
  chosenTaskType: z.string().optional(),
  rationale: z.string(),
  executionPlan: z.array(z.string()),
});

const ARBITER_JSON_SCHEMA: GeminiJsonSchema = {
  type: "object",
  properties: {
    finalDecision: { type: "string", enum: ["builtin", "custom"], description: "Use built-in handler or custom approach" },
    chosenTaskType: { type: "string", description: "If builtin, which task type to use" },
    rationale: { type: "string", description: "Why this decision was made" },
    executionPlan: { type: "array", items: { type: "string" }, description: "Step-by-step execution plan" },
  },
  required: ["finalDecision", "rationale", "executionPlan"],
};

// ── Council Configuration ────────────────────────────────────────────

interface CouncilMember {
  name: string;
  model: string;
  perspective: string;
}

const COUNCIL_MEMBERS: CouncilMember[] = [
  {
    name: "Analyst",
    model: "gemini-2.5-flash",
    perspective: "Focus on understanding the business requirements and what the user actually needs accomplished. Consider the domain context (Norwegian accounting, Tripletex API).",
  },
  {
    name: "Engineer",
    model: "gemini-2.5-flash",
    perspective: "Focus on the technical implementation. Consider API limitations, BETA endpoint restrictions, and the most efficient way to accomplish the task with minimal API calls.",
  },
  {
    name: "Pragmatist",
    model: "gemini-2.5-flash",
    perspective: "Focus on what's most likely to succeed. Consider past failures, edge cases, and prefer proven approaches over clever solutions.",
  },
];

// ── System Prompts ───────────────────────────────────────────────────

function buildReasoningPrompt(member: CouncilMember): string {
  const taskTypeList = PROMPT_TEMPLATES.map((t: { taskType: string; template: string }) => `- ${t.taskType}: ${t.template.slice(0, 80)}`).join("\n");

  return `You are the "${member.name}" in a council of AI advisors solving a Tripletex accounting task.

${member.perspective}

Available built-in task handlers:
${taskTypeList}

BETA endpoint restrictions (these often return 403):
- Batch endpoints: /customer/list, /invoice/list, /order/list, /project/list
- Salary endpoints: /salary/transaction, /salary/payslip
- Incoming invoice endpoints (use voucher postings instead)
- DELETE /customer/{id}, PUT /project/{id}, DELETE /project/{id}

When reasoning:
1. Identify what the task is asking for
2. Determine if a built-in handler can accomplish this
3. If not, outline what API calls would be needed
4. Consider potential failure modes

Respond with your reasoning and recommendation.`;
}

const ARBITER_SYSTEM_PROMPT = `You are the arbiter in a council of AI advisors. You have received reasoning from multiple advisors about how to solve a Tripletex accounting task.

Your job:
1. Synthesize the different perspectives
2. Decide whether to use a built-in handler or a custom approach
3. If using a built-in handler, specify which task type
4. Provide a clear rationale for your decision
5. Outline the execution plan

Prefer built-in handlers when:
- A handler clearly matches the task (even if not perfect)
- The custom approach would be complex or risky
- Multiple advisors suggest the same handler

Prefer custom approach when:
- No handler matches the task
- The task requires operations not covered by handlers
- Built-in handlers have known limitations for this case`;

// ── Council Functions ────────────────────────────────────────────────

export interface CouncilResult {
  decision: CouncilDecision;
  reasonings: LLMReasoning[];
  suggestedTask?: ParsedTask;
}

/**
 * Consult the LLM council for guidance on a complex task.
 */
export async function consultCouncil(
  prompt: string,
  currentClassification: TaskType,
  entities: Record<string, unknown>[],
  trace: SolveTrace,
): Promise<CouncilResult> {
  // Step 1: Gather reasoning from each council member (in parallel)
  const reasoningPromises = COUNCIL_MEMBERS.map(async (member, index) => {
    const start = performance.now();

    try {
      const { object } = await geminiGenerateStructured({
        model: member.model,
        system: buildReasoningPrompt(member),
        prompt: `Task prompt:\n${prompt}\n\nCurrent classification: ${currentClassification}\nExtracted entities: ${JSON.stringify(entities, null, 2)}`,
        schema: ReasoningSchema,
        jsonSchema: REASONING_JSON_SCHEMA,
        maxTokens: 1024,
      });

      const durationMs = Math.round(performance.now() - start);

      const reasoning: LLMReasoning = {
        model: `${member.name} (${member.model})`,
        reasoning: object.reasoning,
        suggestedApproach: object.suggestedApproach,
        useBuiltInHandler: object.useBuiltInHandler,
        confidence: object.confidence,
        durationMs,
      };

      trace.logReasoning(reasoning, index);
      return reasoning;

    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const errorMsg = error instanceof Error ? error.message : String(error);

      const reasoning: LLMReasoning = {
        model: `${member.name} (${member.model})`,
        reasoning: `Error: ${errorMsg}`,
        suggestedApproach: "Use built-in handler as fallback",
        useBuiltInHandler: true,
        confidence: 0.3,
        durationMs,
      };

      trace.logReasoning(reasoning, index);
      return reasoning;
    }
  });

  const reasonings = await Promise.all(reasoningPromises);

  // Step 2: Arbiter synthesizes and decides
  const arbiterStart = performance.now();
  const reasoningSummary = reasonings.map((r, i) =>
    `Advisor ${i + 1} (${r.model}):\n- Reasoning: ${r.reasoning}\n- Approach: ${r.suggestedApproach}\n- Use built-in: ${r.useBuiltInHandler}\n- Confidence: ${(r.confidence * 100).toFixed(0)}%`
  ).join("\n\n");

  const { object: arbiterResult } = await geminiGenerateStructured({
    model: "gemini-2.5-flash",
    system: ARBITER_SYSTEM_PROMPT,
    prompt: `Original task:\n${prompt}\n\nCurrent classification: ${currentClassification}\n\nAdvisor Recommendations:\n${reasoningSummary}`,
    schema: ArbiterSchema,
    jsonSchema: ARBITER_JSON_SCHEMA,
    maxTokens: 512,
  });

  const decision: CouncilDecision = {
    reasonings,
    finalDecision: arbiterResult.finalDecision,
    chosenApproach: arbiterResult.executionPlan.join(" → "),
    rationale: arbiterResult.rationale,
  };

  trace.logCouncilDecision(decision);

  // Build suggested task if using built-in handler
  let suggestedTask: ParsedTask | undefined;
  if (arbiterResult.finalDecision === "builtin" && arbiterResult.chosenTaskType) {
    suggestedTask = {
      taskType: arbiterResult.chosenTaskType as TaskType,
      entities,
      language: "en", // Will be overridden
      rawPrompt: prompt,
    };
  }

  return {
    decision,
    reasonings,
    suggestedTask,
  };
}

/**
 * Quick check if a task should go to council.
 */
export function shouldConsultCouncil(_taskType: TaskType): boolean {
  // No longer used — all 30 types have dedicated handlers
  return false;
}
