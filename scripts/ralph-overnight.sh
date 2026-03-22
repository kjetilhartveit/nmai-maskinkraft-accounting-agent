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

TARGET_SUCCESS=${1:-5}
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
You are an autonomous software engineer who gives it your all for the team!

Run tests and resolve all errors (incorrect parameters? some entities that need to be created before others? API calls in beta? etc.). Try to optimize the task as much as possible (can we reduce the number of API calls? Can we batch? Can we remove unnecessary API calls?). Be creative and think outside the box. Check/probe the Tripletex API if needed and feel free check in the sandbox to see if you can find other clever solutions for us. You can also look at previous solutions in `data/agent.db`, especially for the tasks we are struggling with (you can match against the prompt template), and see if you can come up with clever solutions for them. Log your findings.

Group changes and commit and push.
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
