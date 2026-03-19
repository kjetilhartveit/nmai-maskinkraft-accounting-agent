## Links

- **App**: https://app.ainm.no
- **Rules**: https://app.ainm.no/rules
- **Docs overview**: https://app.ainm.no/docs
- **Docs - Task Accounting Agent**: https://app.ainm.no/docs/tripletex/overview
- **Task submission**: https://app.ainm.no/submit/tripletex
- **Prizes and how it works**: https://app.ainm.no/prizes
- **Team**: Maskinkraft

## Caveats

- Do **not** submit tasks yet!

# Plan

- [x] Thoroughly examine the task and the docs. Learn the ins and outs of the task. Identify the biggest hurdles and blockers.
  - [x] Explain the most technical aspects in a more easy to understand manner. Teach me as you go. Create a report with your findings. → [FINDINGS.md](docs/plans/1-research/FINDINGS.md)
  - [x] Come up with recommendations with a solution. Be thorough and aim to win the prize by making the best solution. Create a report with your recommendations. → [RECOMMENDATIONS.md](docs/plans/1-research/RECOMMENDATIONS.md)

## Execution of plan

- You should git commit and push regularly, particularly after making many code changes.
- After every step you should tick the step off the plan and make sure everything is committed and pushed.
- Be autonomous, but if you need my input then ask for it in [QA.md](QA.md).

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
