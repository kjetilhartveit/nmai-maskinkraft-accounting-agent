import { config } from "./config.js";
import type { ZodType } from "zod";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Attempt to repair common JSON issues from LLM output:
 * - Trailing commas before } or ]
 * - Single-quoted strings
 * - Unquoted property names
 * - Truncated JSON (close unclosed brackets)
 */
function repairJson(text: string): string {
  // Remove trailing commas before closing brackets
  let fixed = text.replace(/,\s*([\]}])/g, "$1");

  // Try parsing as-is first
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    // Continue with more aggressive repairs
  }

  // Replace single-quoted strings with double-quoted (outside of double-quoted strings)
  {
    let result = "";
    let inDouble = false;
    let inSingle = false;
    let esc = false;
    for (let i = 0; i < fixed.length; i++) {
      const ch = fixed[i];
      if (esc) { result += ch; esc = false; continue; }
      if (ch === "\\") { result += ch; esc = true; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; result += ch; continue; }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        result += '"';
        continue;
      }
      result += ch;
    }
    fixed = result;
  }

  // Fix unquoted property names: word before colon outside strings
  fixed = fixed.replace(/(?<=[\{,]\s*)([a-zA-Z_]\w*)(?=\s*:)/g, '"$1"');

  // Remove trailing commas again after other fixes
  fixed = fixed.replace(/,\s*([\]}])/g, "$1");

  // Try parsing after string/key repairs
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    // Continue with structural repairs
  }

  // Close unclosed arrays and objects
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of fixed) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") openBraces++;
    if (ch === "}") openBraces--;
    if (ch === "[") openBrackets++;
    if (ch === "]") openBrackets--;
  }

  // Remove any trailing partial key-value or comma
  fixed = fixed.replace(/,?\s*"[^"]*"?\s*:?\s*$/, "");
  fixed = fixed.replace(/,\s*$/, "");

  while (openBrackets > 0) { fixed += "]"; openBrackets--; }
  while (openBraces > 0) { fixed += "}"; openBraces--; }

  return fixed;
}

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
  maxRetries?: number;
}): Promise<{ object: T; durationMs: number }> {
  const model = options.model ?? config.google.model;
  const maxRetries = options.maxRetries ?? 2;
  const start = performance.now();

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await callGemini(model, {
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        systemInstruction: { parts: [{ text: options.system }] },
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: options.maxTokens ?? 8192,
          temperature: attempt > 0 ? 0.1 : 0,
          topP: 1,
          topK: 1,
        },
      });

      const durationMs = Math.round(performance.now() - start);
      let text = (result.candidates[0].content.parts[0] as { text: string }).text.trim();
      text = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
      const parsed = JSON.parse(repairJson(text));
      const object = options.schema.parse(parsed) as T;
      return { object, durationMs };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        console.warn(`[Gemini] Structured parse attempt ${attempt + 1} failed, retrying...`);
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
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 16384,
        temperature: 0,
        topP: 1,
        topK: 1,
      },
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
