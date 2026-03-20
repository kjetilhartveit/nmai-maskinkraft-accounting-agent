import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";
import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { config } from "../lib/config.js";
import { TRIPLETEX_API_REFERENCE } from "../lib/tripletex-api-reference.js";

const MAX_STEPS = 25;

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.openrouter.apiKey,
  compatibility: "compatible",
});

function buildSystemPrompt(): string {
  return `You are an expert Tripletex accounting API agent. You receive a task description and must execute it by making the correct API calls to the Tripletex API.

You have tools to make HTTP requests to the Tripletex API. Authentication is handled automatically.

IMPORTANT RULES:
1. Read the task carefully and identify ALL required operations.
2. Create dependencies first (e.g., customer before invoice, department before employee).
3. Use GET requests to search for existing resources before creating duplicates.
4. All dates MUST be in YYYY-MM-DD format.
5. Voucher postings MUST balance (debits = credits).
6. When creating resources, use the MINIMUM required fields to avoid validation errors.
7. If a POST fails with 422, read the error message carefully — it tells you which field is wrong.
8. For custom accounting dimensions: create the dimension name first, then create values using the returned dimensionIndex.
9. The sandbox is fresh/empty — you must create all prerequisites.
10. Be efficient: minimize the number of API calls. Don't make unnecessary GET requests.
11. When you're done, stop calling tools and summarize what you did.

${TRIPLETEX_API_REFERENCE}`;
}

function buildUserPrompt(task: ParsedTask): string {
  const parts = [`Complete the following accounting task:\n\n${task.rawPrompt}`];

  if (task.entities.length > 0) {
    parts.push(
      `\nExtracted data from the prompt:\n${JSON.stringify(task.entities, null, 2)}`,
    );
  }

  parts.push(
    `\nDetected language: ${task.language}`,
    `\nTask type hint: ${task.taskType}`,
    `\nExecute the necessary API calls now.`,
  );

  return parts.join("\n");
}

export async function handleGenericTask(
  client: TripletexClient,
  task: ParsedTask,
  _ctx: SequenceContext,
): Promise<void> {
  console.log(
    `[GenericHandler] Starting agentic execution for: ${task.taskType}`,
  );
  console.log(`[GenericHandler] Prompt: ${task.rawPrompt.slice(0, 200)}...`);

  const modelId = config.openrouter.model;

  const { text, steps } = await generateText({
    model: openrouter(modelId),
    system: buildSystemPrompt(),
    prompt: buildUserPrompt(task),
    maxSteps: MAX_STEPS,
    tools: {
      tripletex_get: tool({
        description:
          "Make a GET request to the Tripletex API. Use for searching/listing resources.",
        parameters: z.object({
          endpoint: z
            .string()
            .describe(
              'API endpoint path, e.g. "/employee", "/ledger/account"',
            ),
          params: z
            .record(z.string())
            .optional()
            .describe(
              'Query parameters, e.g. { "name": "Acme", "from": "0", "count": "10" }',
            ),
        }),
        execute: async ({ endpoint, params }) => {
          console.log(
            `[GenericHandler] GET ${endpoint} ${params ? JSON.stringify(params) : ""}`,
          );
          try {
            const result = await client.list<unknown>(endpoint, params);
            return {
              success: true,
              fullResultSize: result.fullResultSize,
              count: result.values.length,
              values: result.values,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[GenericHandler] GET ${endpoint} failed: ${msg}`);
            return { success: false, error: msg };
          }
        },
      }),
      tripletex_post: tool({
        description:
          "Make a POST request to the Tripletex API. Use for creating new resources.",
        parameters: z.object({
          endpoint: z
            .string()
            .describe('API endpoint path, e.g. "/employee", "/customer"'),
          body: z
            .record(z.unknown())
            .describe("JSON body for the request"),
        }),
        execute: async ({ endpoint, body }) => {
          console.log(
            `[GenericHandler] POST ${endpoint} ${JSON.stringify(body).slice(0, 300)}`,
          );
          try {
            const result = await client.post<unknown>(endpoint, body);
            return { success: true, value: result.value };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[GenericHandler] POST ${endpoint} failed: ${msg}`);
            return { success: false, error: msg };
          }
        },
      }),
      tripletex_put: tool({
        description:
          "Make a PUT request to the Tripletex API. Use for updating existing resources.",
        parameters: z.object({
          endpoint: z
            .string()
            .describe(
              'API endpoint path with ID, e.g. "/employee/123", "/company"',
            ),
          body: z
            .record(z.unknown())
            .describe(
              "JSON body for the request. Must include id and version fields for most resources.",
            ),
        }),
        execute: async ({ endpoint, body }) => {
          console.log(
            `[GenericHandler] PUT ${endpoint} ${JSON.stringify(body).slice(0, 300)}`,
          );
          try {
            const result = await client.put<unknown>(endpoint, body);
            return { success: true, value: result.value };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[GenericHandler] PUT ${endpoint} failed: ${msg}`);
            return { success: false, error: msg };
          }
        },
      }),
      tripletex_delete: tool({
        description:
          "Make a DELETE request to the Tripletex API. Use for removing resources.",
        parameters: z.object({
          endpoint: z
            .string()
            .describe(
              'API endpoint path with ID, e.g. "/employee/123", "/travelExpense/456"',
            ),
        }),
        execute: async ({ endpoint }) => {
          console.log(`[GenericHandler] DELETE ${endpoint}`);
          try {
            await client.delete(endpoint);
            return { success: true };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[GenericHandler] DELETE ${endpoint} failed: ${msg}`,
            );
            return { success: false, error: msg };
          }
        },
      }),
    },
  });

  const totalToolCalls = steps.reduce(
    (sum, step) => sum + (step.toolCalls?.length ?? 0),
    0,
  );
  console.log(
    `[GenericHandler] Completed in ${steps.length} step(s), ${totalToolCalls} tool call(s)`,
  );
  if (text) {
    console.log(`[GenericHandler] Summary: ${text.slice(0, 500)}`);
  }
}
