import "dotenv/config";

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

  openrouter: {
    apiKey: required("OPENROUTER_API_KEY"),
    model: optional("OPENROUTER_MODEL", "anthropic/claude-sonnet-4"),
  },

  sandbox: {
    apiUrl: optional("SANDBOX_API_URL", ""),
    sessionToken: optional("SANDBOX_SESSION_TOKEN", ""),
  },
} as const;
