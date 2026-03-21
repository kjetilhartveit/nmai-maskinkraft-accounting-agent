/**
 * OpenRouter API client for LLM calls.
 * Uses OpenAI-compatible API format.
 */

import "dotenv/config";
import { z, type ZodType } from "zod";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterOptions {
  model?: string;
  system: string;
  prompt: string;
  schema: ZodType<unknown>;
  maxTokens?: number;
  maxRetries?: number;
}

export async function openrouterGenerateStructured<T>(
  options: OpenRouterOptions & { schema: ZodType<T> },
): Promise<{ object: T; durationMs: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY environment variable");
  }

  const model = options.model ?? "google/gemini-3.1-flash-lite-preview";
  const maxRetries = options.maxRetries ?? 2;
  const start = performance.now();

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/nmai-maskinkraft",
          "X-Title": "NMAI Accounting Agent",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.prompt },
          ],
          max_tokens: options.maxTokens ?? 256,
          temperature: attempt > 0 ? 0.1 : 0,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
      }

      const data = await response.json();
      const durationMs = Math.round(performance.now() - start);

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("Empty response from OpenRouter");
      }

      // Parse JSON and validate with schema
      const parsed = JSON.parse(content);
      const object = options.schema.parse(parsed) as T;

      return { object, durationMs };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        console.warn(`[OpenRouter] Attempt ${attempt + 1} failed, retrying...`);
      }
    }
  }

  throw lastError;
}
