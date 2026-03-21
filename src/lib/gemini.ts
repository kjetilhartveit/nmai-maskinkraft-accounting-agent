import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  type Content,
  type Part,
} from "@google/genai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config } from "./config.js";
import type { ZodType } from "zod";

const ai = new GoogleGenAI({ apiKey: config.google.apiKey });

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * JSON Schema type for Gemini's responseSchema (subset of OpenAPI 3.0).
 * Kept for backward compatibility — prefer letting zodToJsonSchema derive it.
 */
export type GeminiJsonSchema = {
  type: "object" | "array" | "string" | "number" | "boolean";
  properties?: Record<string, GeminiJsonSchema>;
  items?: GeminiJsonSchema;
  required?: string[];
  enum?: string[];
  description?: string;
};

// ── Structured JSON output ─────────────────────────────────────────────────

export async function geminiGenerateStructured<T>(options: {
  model?: string;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  /** Optional JSON Schema override. If omitted, derived automatically from the Zod schema via zodToJsonSchema. */
  jsonSchema?: GeminiJsonSchema;
  maxTokens?: number;
  maxRetries?: number;
}): Promise<{ object: T; durationMs: number }> {
  const model = options.model ?? config.google.model;
  const maxRetries = options.maxRetries ?? 2;
  const start = performance.now();

  const responseJsonSchema =
    options.jsonSchema ?? zodToJsonSchema(options.schema);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: options.prompt,
        config: {
          systemInstruction: options.system,
          responseMimeType: "application/json",
          responseJsonSchema,
          maxOutputTokens: options.maxTokens ?? 8192,
          temperature: attempt > 0 ? 0.1 : 0,
          topP: 1,
          topK: 1,
        },
      });

      const durationMs = Math.round(performance.now() - start);
      const text = response.text;

      if (!text || text.length < 2) {
        throw new Error("Empty or truncated JSON response");
      }

      const parsed = JSON.parse(text);
      const object = options.schema.parse(parsed) as T;
      return { object, durationMs };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        console.warn(
          `[Gemini] Structured parse attempt ${attempt + 1} failed, retrying...`,
        );
      }
    }
  }

  throw lastError;
}

// ── Tool-calling agent loop ────────────────────────────────────────────────

export interface GeminiToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export async function geminiGenerateWithTools(options: {
  model?: string;
  system: string;
  prompt: string;
  tools: GeminiToolDef[];
  maxSteps?: number;
  maxTokens?: number;
}): Promise<{ text: string; steps: number; toolCalls: number }> {
  const model = options.model ?? config.google.model;
  const maxSteps = options.maxSteps ?? 25;

  const functionDeclarations = options.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));

  const toolMap = new Map(options.tools.map((t) => [t.name, t]));

  const contents: Content[] = [
    { role: "user", parts: [{ text: options.prompt }] },
  ];

  let steps = 0;
  let totalToolCalls = 0;
  let finalText = "";

  while (steps < maxSteps) {
    steps++;

    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: options.system,
        tools: [{ functionDeclarations }],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
        },
        maxOutputTokens: options.maxTokens ?? 16384,
        temperature: 0,
        topP: 1,
        topK: 1,
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) break;

    contents.push({ role: "model", parts: candidate.content.parts });

    const functionCalls = response.functionCalls;

    if (!functionCalls || functionCalls.length === 0) {
      finalText = response.text ?? "";
      break;
    }

    const responseParts: Part[] = [];
    for (const fc of functionCalls) {
      const name = fc.name!;
      const args = (fc.args ?? {}) as Record<string, unknown>;
      totalToolCalls++;

      const tool = toolMap.get(name);
      if (!tool) {
        responseParts.push({
          functionResponse: {
            name,
            response: { error: `Unknown tool: ${name}` },
          },
        });
        continue;
      }

      try {
        const toolResult = await tool.execute(args);
        responseParts.push({
          functionResponse: {
            name,
            response: toolResult as Record<string, unknown>,
          },
        });
      } catch (err) {
        responseParts.push({
          functionResponse: {
            name,
            response: {
              error: err instanceof Error ? err.message : String(err),
            },
          },
        });
      }
    }

    contents.push({ role: "user", parts: responseParts });
  }

  return { text: finalText, steps, toolCalls: totalToolCalls };
}
