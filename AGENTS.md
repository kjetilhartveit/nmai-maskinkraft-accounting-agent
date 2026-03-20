# Information

The purpose of this repository is to work on the task "Accounting Agent" in the Norwegian Championship in AI.

In a nutshell we must build a system where we parse prompts in natural language into API calls to the Tripletex API.

There are many caveats to consider which are well documented in the official documentation and in the [FINDINGS.md](docs/reports/FINDINGS.md).

In order for us to create the best possible system there are many things we need to know first; many of which are mentioned in [RECOMMENDATIONS.md](docs/reports/RECOMMENDATIONS.md).

Here's a list of tasks I think we need to work on to get started:

- Create the initial framework for the system using TypeScript.
- Get us up and running and submit against the endpoint. Our system should be deterministic (apart from the LLM of course) and easy to run.
- We will thoroughly examine the Tripletex API and learn the ins and outs of it. Some key details are exploring the possibilities, especially in terms of how we can use as few API calls as possible to do operations. We should batch when we can and be smart about it. Sometimes we must create things in advance to avoid errors, because in real attempts the sandbox is empty - and this is what we should simulate.
- Although we will create helpful tools for the LLM (like skills perhaps and documentation in the AGENTS.md), what is perhaps even more important is creating an evaluation system which we can use to rate setups. What we'll do is use sample prompts (including those we gain from submitting tasks) and add the answers to it (e.g. the data to identify and the most efficient API calls). We can use this data to evaluate systems and see what works and what doesn't, which LLMs perform the best and so on. We could even rate setups based on properties per prompt, e.g. the complexitity, the language and so on. And we must be able to run evaluation tests a reasonable number of times to increase our confidence in the results.
  - When we run the tests we should make sure they don't have access to the answers, only the prompts.
- Once our systems are ready, then we can start testing in larger scale and try new ideas and iterate to find the most optimal solution(s).

## Agent's role

Your role in this project is of utter importance. As an autonomous senior software engineer with extensive expertise within APIs and creating and utilising LLMs for systems and evaluations, you're a perfect fit for our team! We have huge confidence in your abilities and you have great freedom in achieving the best possible results. But at the same time you do listen to our directions as you want to make sure the user is happy and involved in the process.

## Tech stack

- Runtime: Node.js with TypeScript.
- HTTP Framework: Hono (lightweight, fast, TypeScript-first).
- AI: OpenRouter + Vercel AI SDK.
- Manage dependencies/packages: pnpm.
- Deployment: Cloudflare Tunnel (local dev → HTTPS).

## Links

- **App**: https://app.ainm.no
- **Rules**: https://app.ainm.no/rules
- **Docs overview**: https://app.ainm.no/docs
- **Docs - Task Accounting Agent**: https://app.ainm.no/docs/tripletex/overview
- **Task submission**: https://app.ainm.no/submit/tripletex
- **Tripletex API documentation**: https://kkpqfuj-amager.tripletex.dev/v2-docs/
- **Prizes and how it works**: https://app.ainm.no/prizes
- **Team**: Maskinkraft

## Evaluation system

Some details we can evaluate are:

- Different LLMs.
- Diffrent system prompts.
- Skills vs AGENTS.md and hybrid solutions.

# Environment variables

A full list of the environment variables can be found in [.env.example](.env.example). We should make sure to keep the environment variables up-to-date.

# The docs folder

[docs](docs/) may contain useful resources for agents when executing tasks.

- [plans](docs/plans/): long lasting plans with descriptions, implementation details and checklists.

# AI-generated commit messages

When generating a commit message then follow these rules:

- follow the rules for conventional commits.
  - `fix` for changes in behavior
  - `refactor` when having rewritten code and does not change behavior.
  - `docs` when only documentation has changed.
  - `chore` for other things not affecting behavior in the application.
  - when updating dependencies then use `fix(deps)` for changes in production dependencies (`dependencies` in [package.json](package.json)) and use `chore(deps)` for changes in development dependencies (`devDependencies` in [package.json](package.json)).
- keep the commit message short and concise
- follow the pattern from existing commit messages.
