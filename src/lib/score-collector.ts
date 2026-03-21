import db from "./db.js";

const NMIAI_API_URL = "https://api.ainm.no/tripletex/my/submissions";

interface Submission {
  queued_at: string;
  score_raw?: number;
  score_max?: number;
  normalized_score?: number;
  feedback?: {
    comment?: string;
    checks?: string[];
  };
}

function getAccessToken(): string | null {
  return process.env.AINM_ACCESS_TOKEN || null;
}

function checkTokenExpiry(token: string): { valid: boolean; hoursLeft: number } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: true, hoursLeft: Infinity };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    const exp = payload.exp as number;
    if (!exp) return { valid: true, hoursLeft: Infinity };
    const hoursLeft = (exp - Date.now() / 1000) / 3600;
    return { valid: hoursLeft > 0, hoursLeft };
  } catch {
    return { valid: true, hoursLeft: Infinity };
  }
}

function isoToUnixSeconds(iso: string): number {
  return new Date(iso).getTime() / 1000;
}

/**
 * Fetch submissions from NM i AI API, match to local competition solves by
 * timestamp proximity, and update score/checks columns.
 */
export async function collectScores(options?: { verbose?: boolean }): Promise<number> {
  const token = getAccessToken();
  if (!token) {
    if (options?.verbose) console.log("[Scores] AINM_ACCESS_TOKEN not set — skipping");
    return 0;
  }

  const { valid, hoursLeft } = checkTokenExpiry(token);
  if (!valid) {
    console.error("[Scores] AINM_ACCESS_TOKEN EXPIRED. Refresh from app.ainm.no cookies.");
    return 0;
  }
  if (hoursLeft < 12 && options?.verbose) {
    console.warn(`[Scores] Token expires in ${hoursLeft.toFixed(1)}h — refresh soon`);
  }

  let submissions: Submission[];
  try {
    const res = await fetch(NMIAI_API_URL, {
      headers: {
        Cookie: `access_token=${token}`,
        "User-Agent": "maskinkraft-agent/1.0",
      },
    });
    if (!res.ok) {
      if (options?.verbose) console.error(`[Scores] API returned ${res.status}`);
      return 0;
    }
    submissions = (await res.json()) as Submission[];
  } catch (err) {
    if (options?.verbose) console.error("[Scores] Fetch failed:", err);
    return 0;
  }

  if (!submissions?.length) {
    if (options?.verbose) console.log("[Scores] No submissions from API");
    return 0;
  }

  const subList = submissions
    .map((s) => ({ ts: isoToUnixSeconds(s.queued_at), sub: s }))
    .filter((s) => !isNaN(s.ts) && s.ts > 0);

  if (!subList.length) return 0;

  const unscored = db
    .prepare(
      `SELECT id, timestamp FROM solves
       WHERE score_earned IS NULL AND source IN ('competition')
       ORDER BY timestamp DESC`,
    )
    .all() as { id: string; timestamp: string }[];

  if (!unscored.length) {
    if (options?.verbose) console.log("[Scores] No unscored competition solves");
    return 0;
  }

  const updateStmt = db.prepare(
    `UPDATE solves SET score_earned = ?, score_max = ?, checks_passed = ?,
     checks_total = ?, checks_detail = ? WHERE id = ?`,
  );

  let updated = 0;
  for (const solve of unscored) {
    const solveTs = isoToUnixSeconds(solve.timestamp);
    if (isNaN(solveTs)) continue;

    let bestSub: Submission | null = null;
    let bestDiff = Infinity;
    for (const { ts, sub } of subList) {
      const diff = Math.abs(ts - solveTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestSub = sub;
      }
    }

    if (!bestSub || bestDiff > 3.0) continue;

    const normalized = bestSub.normalized_score ?? 0;
    const scoreMax = bestSub.score_max ?? 0;
    const checks = bestSub.feedback?.checks ?? [];
    const checksPassed = checks.filter((c) => c.toLowerCase().includes("passed")).length;
    const checksTotal = checks.length;

    updateStmt.run(
      normalized,
      scoreMax,
      checksPassed,
      checksTotal,
      JSON.stringify(checks),
      solve.id,
    );
    updated++;

    if (options?.verbose) {
      console.log(
        `  ${solve.id.slice(0, 20)} → ${normalized.toFixed(2)} (${checksPassed}/${checksTotal} checks, Δ${bestDiff.toFixed(1)}s)`,
      );
    }
  }

  if (updated > 0 && options?.verbose) {
    console.log(`[Scores] Updated ${updated} solves`);
  }

  return updated;
}
