// Archived: OpenRouter + Vercel AI SDK
// import { createOpenAI } from "@ai-sdk/openai";
// import { generateText, tool } from "ai";
// import { z } from "zod";
// const openrouter = createOpenAI({
//   baseURL: "https://openrouter.ai/api/v1",
//   apiKey: config.openrouter.apiKey,
//   compatibility: "compatible",
// });

import type { TripletexClient } from "../lib/tripletex-client.js";
import type { ParsedTask } from "../types/index.js";
import type { SequenceContext } from "../lib/sequence-context.js";
import { config } from "../lib/config.js";
import { TRIPLETEX_API_REFERENCE } from "../lib/tripletex-api-reference.js";
import { searchEndpoints, getEndpointDetail } from "../lib/openapi-index.js";
import { geminiGenerateWithTools, type GeminiToolDef } from "../lib/gemini.js";

const MAX_STEPS = 25;

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
10. Be efficient: minimize the number of API calls. Use tripletex_post_list for batch creation (e.g. /department/list, /product/list).
11. When you're done, stop calling tools and summarize what you did.
12. If you're unsure about an endpoint's exact path, parameters, or required fields, use the api_search tool first to look it up in the full Tripletex API documentation (546 endpoints available).

CRITICAL endpoint patterns:
- List endpoints require date params: GET /invoice needs invoiceDateFrom + invoiceDateTo, GET /order needs orderDateFrom + orderDateTo
- Payment registration: use tripletex_put_action with PUT /invoice/{id}/:payment and query params: paymentDate, paymentTypeId, paidAmount
- Action endpoints (containing /:action) use QUERY PARAMETERS, not request bodies. Use the tripletex_put_action tool for these.
- Single-object GET (with ID in path like /invoice/123) returns { value: {...} }, NOT a list
- VOUCHER POSTINGS: Only use these fields in posting objects: { account: {id}, date, amountGross, amountGrossCurrency, description }
  Set amountGross and amountGrossCurrency to the SAME value. Do NOT add dimension1, freeDimension1, accountingDimension1, or customDimension1 — these fields DO NOT EXIST on the posting object and will cause 422 errors.
  For custom dimensions: just create the dimension name + values. The voucher is separate.

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

  const tools: GeminiToolDef[] = [
    {
      name: "tripletex_get",
      description:
        "Make a GET request to the Tripletex API. Use for searching/listing resources. For list endpoints, returns { values: [...], fullResultSize }. For single-object endpoints (with ID), returns { value: {...} }.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path, e.g. "/employee", "/ledger/account", "/invoice/123"',
          },
          params: {
            type: "object",
            description: 'Query parameters as string key-value pairs, e.g. { "name": "Acme", "from": "0", "count": "10" }',
          },
        },
        required: ["endpoint"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const params = args.params as Record<string, string> | undefined;
        console.log(`[GenericHandler] GET ${endpoint} ${params ? JSON.stringify(params) : ""}`);
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
    },
    {
      name: "tripletex_post",
      description: "Make a POST request to the Tripletex API. Use for creating new resources.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path, e.g. "/employee", "/customer"',
          },
          body: {
            type: "object",
            description: "JSON body for the request",
          },
        },
        required: ["endpoint", "body"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const body = args.body as Record<string, unknown>;
        console.log(`[GenericHandler] POST ${endpoint} ${JSON.stringify(body).slice(0, 300)}`);
        try {
          const result = await client.post<unknown>(endpoint, body);
          return { success: true, value: result.value };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] POST ${endpoint} failed: ${msg}`);
          return { success: false, error: msg };
        }
      },
    },
    {
      name: "tripletex_put",
      description: "Make a PUT request with a JSON body. Use for updating existing resources (include id and version).",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path with ID, e.g. "/employee/123", "/company"',
          },
          body: {
            type: "object",
            description: "JSON body for the request. Must include id and version fields for most resources.",
          },
        },
        required: ["endpoint", "body"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const body = args.body as Record<string, unknown>;
        console.log(`[GenericHandler] PUT ${endpoint} ${JSON.stringify(body).slice(0, 300)}`);
        try {
          const result = await client.put<unknown>(endpoint, body);
          return { success: true, value: result.value };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] PUT ${endpoint} failed: ${msg}`);
          return { success: false, error: msg };
        }
      },
    },
    {
      name: "tripletex_put_action",
      description:
        'Make a PUT request with QUERY PARAMETERS (no body). Use for action endpoints like "PUT /invoice/{id}/:payment", "PUT /travelExpense/:deliver", etc. These endpoints use query params instead of a JSON body.',
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path with action, e.g. "/invoice/123/:payment"',
          },
          params: {
            type: "object",
            description: 'Query parameters as string key-value pairs, e.g. { "paymentDate": "2026-03-20", "paymentTypeId": "123", "paidAmount": "10000" }',
          },
        },
        required: ["endpoint", "params"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const params = args.params as Record<string, string>;
        const qs = new URLSearchParams(params).toString();
        const fullEndpoint = `${endpoint}?${qs}`;
        console.log(`[GenericHandler] PUT-ACTION ${fullEndpoint}`);
        try {
          const result = await client.put<unknown>(fullEndpoint, undefined);
          return { success: true, value: result.value };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] PUT-ACTION ${fullEndpoint} failed: ${msg}`);
          return { success: false, error: msg };
        }
      },
    },
    {
      name: "tripletex_post_list",
      description:
        "Make a POST request with an ARRAY body to a /list endpoint. Use for batch creating multiple resources at once (e.g. POST /department/list, POST /product/list). Returns { values: [...] }.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API list endpoint path, e.g. "/department/list", "/product/list"',
          },
          body: {
            type: "array",
            items: { type: "object" },
            description: "Array of JSON objects to create",
          },
        },
        required: ["endpoint", "body"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        const body = args.body as Record<string, unknown>[];
        console.log(`[GenericHandler] POST-LIST ${endpoint} (${body.length} items)`);
        try {
          const result = await client.postList<unknown>(endpoint, body);
          return {
            success: true,
            count: result.values.length,
            values: result.values,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] POST-LIST ${endpoint} failed: ${msg}`);
          return { success: false, error: msg };
        }
      },
    },
    {
      name: "tripletex_delete",
      description: "Make a DELETE request to the Tripletex API. Use for removing resources.",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: 'API endpoint path with ID, e.g. "/employee/123", "/travelExpense/456"',
          },
        },
        required: ["endpoint"],
      },
      execute: async (args) => {
        const endpoint = args.endpoint as string;
        console.log(`[GenericHandler] DELETE ${endpoint}`);
        try {
          await client.delete(endpoint);
          return { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[GenericHandler] DELETE ${endpoint} failed: ${msg}`);
          return { success: false, error: msg };
        }
      },
    },
    {
      name: "api_search",
      description:
        "Search the Tripletex API documentation for endpoints matching a keyword or topic. Use this BEFORE making API calls to unfamiliar endpoints to learn the correct path, parameters, and required fields.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'Search query, e.g. "salary", "bank reconciliation", "asset", "incoming invoice"',
          },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const query = args.query as string;
        console.log(`[GenericHandler] API-SEARCH: "${query}"`);
        return { docs: searchEndpoints(query, 8) };
      },
    },
    {
      name: "api_endpoint_detail",
      description:
        "Get detailed documentation for a specific API endpoint (path + method). Returns parameters, required fields, and response schema.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'API path, e.g. "/salary/payslip"',
          },
          method: {
            type: "string",
            description: 'HTTP method, e.g. "GET", "POST"',
          },
        },
        required: ["path", "method"],
      },
      execute: async (args) => {
        const path = args.path as string;
        const method = args.method as string;
        console.log(`[GenericHandler] API-DETAIL: ${method} ${path}`);
        return { docs: getEndpointDetail(path, method) };
      },
    },
  ];

  const { text, steps, toolCalls } = await geminiGenerateWithTools({
    model: config.google.model,
    system: buildSystemPrompt(),
    prompt: buildUserPrompt(task),
    tools,
    maxSteps: MAX_STEPS,
    maxTokens: 16384,
  });

  console.log(
    `[GenericHandler] Completed in ${steps} step(s), ${toolCalls} tool call(s)`,
  );
  if (text) {
    console.log(`[GenericHandler] Summary: ${text.slice(0, 500)}`);
  }
}
