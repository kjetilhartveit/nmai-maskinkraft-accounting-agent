# Questions from agent to user

These questions are blocking — I need answers before I can proceed with the implementation steps.

## Q1: LLM API key and provider

Which LLM provider should we use for prompt parsing? The recommendations suggest Claude (Anthropic), but OpenAI is also a strong option. Do you have an API key ready?

- **Option A:** Anthropic (Claude) — excellent multilingual + multimodal, recommended in FINDINGS.md
- **Option B:** OpenAI (GPT-4o) — also strong multilingual + multimodal
- **Option C:** Both — we can abstract the LLM layer and swap easily

### Answer

(waiting for user answer)

## Q2: Sandbox credentials

Have you obtained your sandbox credentials from https://app.ainm.no/submit/tripletex? We need a base URL and session token to test against the Tripletex API during development.

### Answer

(waiting for user answer)

## Q3: Vipps verification

Is the team Vipps-verified on the platform? This affects our rate limits significantly:
- **Verified:** 3 concurrent submissions, 4 per task per day
- **Unverified:** 1 concurrent, 2 per task per day

### Answer

(waiting for user answer)

## Q4: Deployment strategy

How do you want to deploy the agent? We need HTTPS for the competition endpoint.

- **Option A:** Cloudflare Tunnel (`npx cloudflared`) — quickest for local development, runs from your machine
- **Option B:** Google Cloud Run — production-grade, auto-scaling, free with GCP account
- **Option C:** Other cloud provider (Azure, AWS, Railway, Fly.io, etc.)
- **Option D:** Start with Cloudflare Tunnel for speed, migrate to Cloud Run later

### Answer

(waiting for user answer)

## Q5: Are you working solo or with a team?

This affects how we structure the code, branching strategy, and whether we need to coordinate work.

### Answer

(waiting for user answer)
