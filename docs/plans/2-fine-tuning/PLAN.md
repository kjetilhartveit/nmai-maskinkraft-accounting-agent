# Fine-tuning

We have set up the project, but we must fine-tune our solution, fix bugs and set ourselves up for success in the competition.

## Plan

- [ ] Our real-life submission is failing with 4/4 checks failed. I still see no output from the live submit, please make sure we store the prompts, the results, the errors, everything. And print it to the terminal and log it.
  - [ ] We can also include live submits in the agent dashboard.
- [ ] Agent dashboard:
  - [ ] We could show one run at the time, and other runs are "archived" in a different tab or something.
- [ ] Do not truncate error messages to 200 symbols, show and persist the entire error message. Check thoroughly, we truncate many places today.
- [ ] In our test cases we have a `expectedApiCalls` but what is actually interesting is the entities that are created or the action that must be done in order to complete the task (remember it's important that we get this right with the correct entitities!). Actual tool calls is something we can also test on, but the most interesting part is that we examine how few tool calls are used in the solution. If we can find a solution which uses fewer API calls and have no errors than the test case, then we should update the test case to reflect this so we don't regress.
  - [ ] This feedback loop in the evals should be automated so we can continuously improve the eval system.
- [ ] I think we can reduce the number of API calls in our evals, sometimes we create department twice and employees twice when we only need to do it once.
- [ ] We should attempt to submit a solution to the competition. Use the browser tool and window to click the submit button, consider the results coming in and act upon them.
- [ ] Note that our solution must not be too rigid with specific tasks, the Tripletex API is quite vast and our system prompt does not cover all the of them. The tool must have a way to access either the official API for reference or our own documentation (if we have a local reference).
- [ ] Once we have come up with an improved solution based on the previous implementation, we try submitting again.

### Execution of plan

- You should git commit and push regularly, particularly after making many code changes.
- After every step you should tick the step off the plan and make sure everything is committed and pushed.
- Be autonomous, but if you need my input then ask for it in [QA.md](QA.md).
