#!/bin/bash
# Ralph overnight improvement script
# Run 5-10 times overnight to iteratively improve the agent system
#
# Usage: ./scripts/ralph-overnight.sh [iterations]
# Default: 5 iterations

set -e

ITERATIONS=${1:-10}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs/ralph"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$LOG_DIR"

echo "=========================================="
echo "Ralph Overnight Improvement Script"
echo "=========================================="
echo "Iterations: $ITERATIONS"
echo "Log directory: $LOG_DIR"
echo "Started at: $(date)"
echo ""

PROMPT="Be autonomous and do not ask for confirmation. You have freedom to do what it takes within your power to make us win the competition!

Analyze the tasks in \`agent.db\` and our test cases. You may read the official documentation about the \"Tripletex\" task to understand exactly what we are trying to achieve.

Our goal is to improve the tasks with the following priorities: **total failure**, **tool calls with wrong parameters**, **increase efficiency by minimizing tool calls** (remove unecessary tool calls, use batching if possible and so on) and so on.

Feedback loop:
- We\'ll use our tasks and tests and our built-in knowledge to mold the information to the LLMs so that they understand and execute the tasks accurately and correctly.
- We should utilise our tests in the sandbox thoroughly to improve the tasks, but do note that LLMs are non-deterministic, so mishaps can occur. We should aim for no errors, but should mainly aim for consistently good solutions.
- We can check directly against the API to see if they work as expected.

Focus areas:
1. Review recent eval results in data/agent.db for patterns of failure
2. Check handlers in src/handlers/ for incorrect API calls or parameters
3. Look at the system prompts and improve guidance based on common errors
4. Verify BETA endpoint handling is correct
5. Optimize tool call sequences to reduce unnecessary API calls

After analysis, make targeted improvements. Run pnpm eval after changes to verify improvements.

Do not submit towards the competition, we are only improving the tasks and the system.

Clean-up inaccurate documentation and slop. Leave the repository in a good/better shape for the next iteration.

Group changes logically and commit and push."

for i in $(seq 1 $ITERATIONS); do
    echo "=========================================="
    echo "Iteration $i of $ITERATIONS"
    echo "Started at: $(date)"
    echo "=========================================="

    LOG_FILE="$LOG_DIR/ralph_${TIMESTAMP}_iter${i}.log"

    # Run gemini agent (redirect to file to avoid PTY issues on Windows)
    cd "$PROJECT_DIR"
    gemini --model gemini-3.1-pro-preview-customtools --yolo -p "$PROMPT" > "$LOG_FILE" 2>&1

    EXIT_CODE=$?

    echo ""
    echo "Iteration $i completed at: $(date)"
    echo "Exit code: $EXIT_CODE"
    echo "Log saved to: $LOG_FILE"
    echo ""

    # Brief pause between iterations to avoid rate limiting
    if [ $i -lt $ITERATIONS ]; then
        echo "Pausing 30 seconds before next iteration..."
        sleep 30
    fi
done

echo "=========================================="
echo "Ralph Overnight Complete"
echo "=========================================="
echo "Finished at: $(date)"
echo "Total iterations: $ITERATIONS"
echo "Logs saved in: $LOG_DIR"
