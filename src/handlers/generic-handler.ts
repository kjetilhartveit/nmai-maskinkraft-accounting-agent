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
4. All dates MUST be in YYYY-MM-DD format. Use 2026 as the year (current year).
5. Voucher postings MUST balance (debits = credits).
6. When creating resources, use the MINIMUM required fields to avoid validation errors.
7. If a POST/PUT fails with 422, read the error message carefully — it tells you which field is wrong. Fix it and retry.
8. For custom accounting dimensions: create the dimension name first, then create values using the returned dimensionIndex.
9. The sandbox MAY have pre-existing data for certain tasks (like invoices for payment tasks). ALWAYS search for existing resources first.
10. Be efficient: minimize the number of API calls.
11. When you're done, stop calling tools and summarize what you did.

CRITICAL endpoint patterns:
- List endpoints require date params: GET /invoice needs invoiceDateFrom + invoiceDateTo, GET /order needs orderDateFrom + orderDateTo
- Payment registration: use tripletex_put_action with PUT /invoice/{id}/:payment and query params: paymentDate, paymentTypeId, paidAmount
- Action endpoints (containing /:action) use QUERY PARAMETERS, not request bodies. Use the tripletex_put_action tool for these.
- Single-object GET (with ID in path like /invoice/123) returns { value: {...} }, NOT a list

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
    `\nToday's date: ${new Date().toISOString().slice(0, 10)}`,
    `\nExecute the necessary API calls now.`,
  );

  return parts.join("\n");
}

function isIdEndpoint(endpoint: string): boolean {
  return /\/\d+$/.test(endpoint) || /\/\d+\/\w+$/.test(endpoint);
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
          "Make a GET request to the Tripletex API. Use for searching/listing resources. For list endpoints, returns { values: [...], fullResultSize }. For single-object endpoints (with ID), returns { value: {...} }.",
        parameters: z.object({
          endpoint: z
            .string()
            .describe(
              'API endpoint path, e.g. "/employee", "/ledger/account", "/invoice/123"',
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
            if (isIdEndpoint(endpoint)) {
              const result = await client.get<unknown>(endpoint, params);
              return { success: true, value: result.value };
            }
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
          "Make a PUT request with a JSON body. Use for updating existing resources (include id and version).",
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
      tripletex_put_action: tool({
        description:
          'Make a PUT request with QUERY PARAMETERS (no body). Use for action endpoints like "PUT /invoice/{id}/:payment", "PUT /travelExpense/:deliver", etc. These endpoints use query params instead of a JSON body.',
        parameters: z.object({
          endpoint: z
            .string()
            .describe(
              'API endpoint path with action, e.g. "/invoice/123/:payment"',
            ),
          params: z
            .record(z.string())
            .describe(
              'Query parameters, e.g. { "paymentDate": "2026-03-20", "paymentTypeId": "123", "paidAmount": "10000" }',
            ),
        }),
        execute: async ({ endpoint, params }) => {
          const qs = new URLSearchParams(params).toString();
          const fullEndpoint = `${endpoint}?${qs}`;
          console.log(
            `[GenericHandler] PUT-ACTION ${fullEndpoint}`,
          );
          try {
            const result = await client.put<unknown>(fullEndpoint, undefined);
            return { success: true, value: result.value };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[GenericHandler] PUT-ACTION ${fullEndpoint} failed: ${msg}`,
            );
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
