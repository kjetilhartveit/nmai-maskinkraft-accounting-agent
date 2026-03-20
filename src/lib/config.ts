import "dotenv/config";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  port: parseInt(optional("PORT", "3000"), 10),

  google: {
    apiKey: required("GOOGLE_API_KEY"),
    model: optional("GOOGLE_MODEL", "gemini-3.1-pro-preview"),
  },

  // Archived: OpenRouter config (switch back by uncommenting and updating llm.ts / generic-handler.ts)
  // openrouter: {
  //   apiKey: required("OPENROUTER_API_KEY"),
  //   model: optional("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.6"),
  // },

  sandbox: {
    apiUrl: optional("SANDBOX_API_URL", ""),
    sessionToken: optional("SANDBOX_SESSION_TOKEN", ""),
  },
} as const;
