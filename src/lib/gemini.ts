import { config } from "./config.js";
import type { ZodType } from "zod";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// ── Types ──────────────────────────────────────────────────────────────────

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: unknown } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: Record<string, unknown>;
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
  toolConfig?: Record<string, unknown>;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiResponse {
  candidates: {
    content: { role: string; parts: GeminiPart[] };
    finishReason: string;
  }[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

// ── Core API call ──────────────────────────────────────────────────────────

async function callGemini(
  model: string,
  request: GeminiRequest,
): Promise<GeminiResponse> {
  const url = `${BASE_URL}/models/${model}:generateContent?key=${config.google.apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<GeminiResponse>;
}

// ── Structured JSON output ─────────────────────────────────────────────────

export async function geminiGenerateStructured<T>(options: {
  model?: string;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  maxTokens?: number;
}): Promise<{ object: T; durationMs: number }> {
  const model = options.model ?? config.google.model;
  const start = performance.now();

  const result = await callGemini(model, {
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    systemInstruction: { parts: [{ text: options.system }] },
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: options.maxTokens ?? 4096,
    },
  });

  const durationMs = Math.round(performance.now() - start);
  const text = (result.candidates[0].content.parts[0] as { text: string }).text;
  const parsed = JSON.parse(text);
  const object = options.schema.parse(parsed) as T;

  return { object, durationMs };
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

  const functionDeclarations: GeminiFunctionDeclaration[] = options.tools.map(
    (t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }),
  );

  const toolMap = new Map(options.tools.map((t) => [t.name, t]));

  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: options.prompt }] },
  ];

  let steps = 0;
  let totalToolCalls = 0;
  let finalText = "";

  while (steps < maxSteps) {
    steps++;

    const result = await callGemini(model, {
      contents,
      systemInstruction: { parts: [{ text: options.system }] },
      tools: [{ functionDeclarations }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: options.maxTokens ?? 16384 },
    });

    const candidate = result.candidates[0];
    const parts = candidate.content.parts;

    contents.push({ role: "model", parts });

    const functionCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        "functionCall" in p,
    );

    if (functionCalls.length === 0) {
      const textParts = parts.filter(
        (p): p is { text: string } => "text" in p,
      );
      finalText = textParts.map((p) => p.text).join("\n");
      break;
    }

    const responseParts: GeminiPart[] = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      totalToolCalls++;

      const tool = toolMap.get(name);
      if (!tool) {
        responseParts.push({
          functionResponse: { name, response: { error: `Unknown tool: ${name}` } },
        });
        continue;
      }

      try {
        const toolResult = await tool.execute(args);
        responseParts.push({
          functionResponse: { name, response: toolResult },
        });
      } catch (err) {
        responseParts.push({
          functionResponse: {
            name,
            response: { error: err instanceof Error ? err.message : String(err) },
          },
        });
      }
    }

    contents.push({ role: "user", parts: responseParts });
  }

  return { text: finalText, steps, toolCalls: totalToolCalls };
}
