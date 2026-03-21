#!/usr/bin/env tsx
import "dotenv/config";
import { collectScores } from "../lib/score-collector.js";

async function main() {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");

  if (help) {
    console.log(`
Score Collector — Fetch competition scores from NM i AI API

Usage:
  pnpm collect-scores              Fetch new scores from API

Requires AINM_ACCESS_TOKEN in .env (JWT from app.ainm.no cookies).
`);
    return;
  }

  console.log("=== Score Collection ===\n");
  console.log("Fetching scores from NM i AI API...");
  const updated = await collectScores({ verbose: true });
  console.log(`  -> ${updated} solves updated from API\n`);
}

main().catch(console.error);
