# Initial setup

## Plan

- [x] Thoroughly examine the task and the docs. Learn the ins and outs of the task. Identify the biggest hurdles and blockers.
  - [x] Explain the most technical aspects in a more easy to understand manner. Teach me as you go. Create a report with your findings. → [FINDINGS.md](docs/reports/FINDINGS.md)
  - [x] Come up with recommendations with a solution. Be thorough and aim to win the prize by making the best solution. Create a report with your recommendations. → [RECOMMENDATIONS.md](docs/reports/RECOMMENDATIONS.md)
- [ ] Look at the next steps and think about my plan specifically in order to achieve the best possible results. What do you think is missing? Feel free to add steps/sub-steps to the plan. You may ask for clarifying questions in [QA.md](QA.md) if needed.
- [ ] Create the initial framework for the system using TypeScript.
- [ ] Get us up and running and submit against the endpoint. Our system should be deterministic (apart from the LLM of course) and easy to run (also for humans). Automate submittions and session tokens etc. as much as possible.
- [ ] We will thoroughly examine the Tripletex API and learn the ins and outs of it. Some key details are exploring the possibilities, especially in terms of how we can use as few API calls as possible to do operations. We should batch when we can and be smart about it. Sometimes we must create things in advance to avoid errors, because in real attempts the sandbox is empty - and this is what we should simulate.
  - [ ] Create a report with your findings in a new report regarding the Tripletex API.
- [ ] **Create a testing framework:** Although we will create helpful tools for the LLM (like skills perhaps and documentation in the AGENTS.md), what is perhaps even more important is creating an evaluation system which we can use to rate setups. What we'll do is use sample prompts (including those we gain from submitting tasks) and add the answers to it (e.g. the data to identify and the most efficient API calls). We can use this data to evaluate systems and see what works and what doesn't, which LLMs perform the best and so on. We could even rate setups based on properties per prompt, e.g. the complexitity, the language and so on. And we must be able to run evaluation tests a reasonable number of times to increase our confidence in the results.
  - When we run the tests we should make sure they don't have access to the answers, only the prompts.
  - How do we scale this up and making it possible to try different setups in parallell and without polluting context?
  - [ ] You may create a new report with reflections around this and suggestions on how we can create the best test suite which suits our needs.
- [ ] **Obtaining data, verifying answers and creating a verification system:** In order for our tests suites to be effective, we must actually verify that the "answers" are indeed the best possible answers. This might be a continuous process to a certain extent. We should run agents against prompts and try to solve the tasks to the best of their ability, and then later a human can verify the results and confirm answers. When it comes to API calls it's not so easy though, because it's hard to say whether the API calls has errors and/or if they are valid and/or work at all.

### Execution of plan

- You should git commit and push regularly, particularly after making many code changes.
- After every step you should tick the step off the plan and make sure everything is committed and pushed.
- Be autonomous, but if you need my input then ask for it in [QA.md](QA.md).
