import "dotenv/config";
import { execSync, spawn } from "child_process";

const SUBMIT_URL = "https://app.ainm.no/submit/tripletex";
const PLATFORM_URL = "https://app.ainm.no";
const SERVER_PORT = process.env.PORT || "3000";

function getAccessToken(): string {
  const token = process.env.AINM_ACCESS_TOKEN;
  if (!token) {
    console.error("Missing AINM_ACCESS_TOKEN in .env");
    console.error("To get it: sign in at https://app.ainm.no via Google,");
    console.error("then extract the access_token cookie from your browser.");
    process.exit(1);
  }
  return token;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}

function checkTokenExpiry(token: string): void {
  try {
    const payload = decodeJwtPayload(token);
    const exp = payload.exp as number;
    if (!exp) {
      console.warn("  Token has no expiry claim — cannot verify validity.");
      return;
    }
    const expiresAt = new Date(exp * 1000);
    const now = new Date();
    const hoursLeft = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursLeft < 0) {
      console.error(`  TOKEN EXPIRED at ${expiresAt.toISOString()}`);
      console.error("  Please refresh: sign in at https://app.ainm.no,");
      console.error("  extract the access_token cookie, update .env");
      process.exit(1);
    }

    console.log(`  Expires: ${expiresAt.toISOString()} (${hoursLeft.toFixed(1)}h remaining)`);
    if (hoursLeft < 12) {
      console.warn("  WARNING: Token expires in less than 12 hours!");
      console.warn("  Consider refreshing soon.");
    }
  } catch {
    console.warn("  Could not decode token — skipping expiry check.");
  }
}

async function checkServerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${SERVER_PORT}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function checkTunnelRunning(): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:3000");
    if (res.ok) return `http://localhost:${SERVER_PORT}`;
  } catch { /* not running */ }
  return null;
}

function printBanner(): void {
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║       NM i AI — Tripletex Submission Workflow        ║");
  console.log("╚════════════════════════════════════════════════════════╝");
  console.log();
}

function printSubmissionInstructions(tunnelUrl?: string): void {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  SUBMISSION STEPS");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();
  console.log("  1. Start the server:     pnpm dev");
  console.log("  2. Start the tunnel:     pnpm tunnel");
  console.log("     → Copy the HTTPS URL from the tunnel output");
  if (tunnelUrl) {
    console.log(`     → Current URL: ${tunnelUrl}`);
  }
  console.log();
  console.log(`  3. Go to: ${SUBMIT_URL}`);
  console.log("  4. Enter the tunnel HTTPS URL as Endpoint URL");
  console.log("  5. (Optional) Set an API key for endpoint protection");
  console.log("  6. Click Submit");
  console.log();
  console.log("  After submission, the platform will:");
  console.log("  - Provision a fresh Tripletex sandbox");
  console.log("  - Send a random task to your /solve endpoint");
  console.log("  - Verify results and score your submission");
  console.log();
  console.log("  All requests are logged to: data/agent.db (SQLite)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

async function main(): Promise<void> {
  printBanner();

  console.log("[1/3] Checking AINM access token...");
  const token = getAccessToken();
  checkTokenExpiry(token);

  console.log();
  console.log("[2/3] Checking local server...");
  const serverRunning = await checkServerHealth();
  if (serverRunning) {
    console.log(`  Server is running on port ${SERVER_PORT}`);
  } else {
    console.log(`  Server is NOT running on port ${SERVER_PORT}`);
    console.log("  Start it with: pnpm dev");
  }

  console.log();
  console.log("[3/3] Checking platform connectivity...");
  try {
    const res = await fetch(PLATFORM_URL, {
      headers: { Cookie: `access_token=${token}` },
      redirect: "manual",
    });
    if (res.status === 200) {
      console.log("  Platform is reachable and token is valid.");
    } else if (res.status === 302 || res.status === 307) {
      console.warn("  Platform redirected — token may be invalid/expired.");
    } else {
      console.warn(`  Platform returned status ${res.status}.`);
    }
  } catch (err) {
    console.error("  Could not reach platform:", err);
  }

  console.log();
  printSubmissionInstructions();

  console.log();
  console.log("NOTE: The competition platform uses Next.js Server Actions,");
  console.log("so programmatic submission is not straightforward. Use the");
  console.log("browser-based workflow above. If you want to automate");
  console.log("repeated submissions, keep the tunnel running and re-submit");
  console.log("from the browser — each click triggers a new evaluation.");
}

main().catch(console.error);
