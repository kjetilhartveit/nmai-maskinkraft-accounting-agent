#!/bin/bash
# Ralph overnight improvement script
# Loops until N successful iterations complete, retrying on 504 errors
#
# Usage: ./scripts/ralph-overnight.sh [target_successes]
# Default: 10 successful iterations

# Don't exit on error - we handle errors ourselves
set +e

# Source bashrc to get aliases like 'vibe'
shopt -s expand_aliases
source ~/.bashrc

TARGET_SUCCESS=${1:-10}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs/ralph"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$LOG_DIR"

echo "=========================================="
echo "Ralph Overnight Improvement Script"
echo "=========================================="
echo "Target successful iterations: $TARGET_SUCCESS"
echo "Log directory: $LOG_DIR"
echo "Started at: $(date)"
echo ""

SUCCESS_COUNT=0
ATTEMPT_COUNT=0

PROMPT=$(cat <<'EOF'
Analyze the tasks in `agent.db` and our test cases. You may read the official documentation about the "Tripletex" task to understand exactly what we are trying to achieve.

Our goal is to improve the tasks with the following priorities: **total failure**, **tool calls with wrong parameters**, **increase efficiency by minimizing tool calls** (remove unecessary tool calls, use batching if possible and so on) and so on.

Feedback loop:
- We'll use our tasks and tests and our built-in knowledge to mold the information to the LLMs so that they understand and execute the tasks accurately and correctly.
- LLMs are non-deterministic, so mishaps can occur. We should aim for no errors, but should mainly aim for consistently good solutions.
- We can check directly against the API using `pnpm probe` to see if endpoints work as expected.

Focus areas:
1. Review recent eval results in data/agent.db for patterns of failure
2. Check handlers in src/handlers/ for incorrect API calls or parameters
3. Look at the system prompts and improve guidance based on common errors
4. Verify BETA endpoint handling is correct
5. Optimize tool call sequences to reduce unnecessary API calls

IMPORTANT - Testing strategy:
- DO NOT run full `pnpm eval` after every change - sandbox tests are expensive.
- Instead, focus on analysis and code improvements first.
- Use `pnpm probe` to verify API endpoint behavior directly (fast, no LLM).
- Only run selective tests with `pnpm eval -- --filter "<specific_case>"` when you've made a targeted fix for that specific case.
- At the END of your iteration, run 1-3 selective tests for the cases you actually changed.

Do not submit towards the competition, we are only improving the tasks and the system.

Clean-up inaccurate documentation and slop. Leave the repository in a good/better shape for the next iteration.
EOF
)

while [ $SUCCESS_COUNT -lt $TARGET_SUCCESS ]; do
    ATTEMPT_COUNT=$((ATTEMPT_COUNT + 1))

    echo "=========================================="
    echo "Attempt $ATTEMPT_COUNT (Success: $SUCCESS_COUNT/$TARGET_SUCCESS)"
    echo "Started at: $(date)"
    echo "=========================================="

    LOG_FILE="$LOG_DIR/ralph_${TIMESTAMP}_attempt${ATTEMPT_COUNT}.log"

    # Run vibe (alias from ~/.bashrc)
    cd "$PROJECT_DIR"
    agent --model "claude-4.6-opus-high-thinking" --force "$PROMPT" 2>&1 | tee "$LOG_FILE"

    EXIT_CODE=${PIPESTATUS[0]}

    echo ""
    echo "Attempt $ATTEMPT_COUNT completed at: $(date)"
    echo "Exit code: $EXIT_CODE"
    echo "Log saved to: $LOG_FILE"

    if [ $EXIT_CODE -eq 0 ]; then
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        echo "SUCCESS! ($SUCCESS_COUNT/$TARGET_SUCCESS successful iterations)"

        # Brief pause between iterations to avoid rate limiting
        if [ $SUCCESS_COUNT -lt $TARGET_SUCCESS ]; then
            echo "Pausing 30 seconds before next iteration..."
            sleep 30
        fi
    else
        echo "FAILED (exit code $EXIT_CODE) - likely 504 timeout, retrying..."
        echo "Pausing 60 seconds before retry..."
        sleep 60
    fi
    echo ""
done

echo "=========================================="
echo "Ralph Overnight Complete"
echo "=========================================="
echo "Finished at: $(date)"
echo "Successful iterations: $SUCCESS_COUNT"
echo "Total attempts: $ATTEMPT_COUNT"
echo "Logs saved in: $LOG_DIR"
