#!/bin/bash
# Auto-restart wrapper for Claude Code sessions.
# If Claude exits (crash, OOM, etc.), waits 5 seconds and restarts.
# Sends a Discord notification on crash and restart.

SESSION="$1"
DIR="$2"
NOTIFY="$HOME/.claude/bin/discord-notify.sh"
MAX_RAPID_CRASHES=5
RAPID_WINDOW=60  # seconds
crash_times=()

cd "$DIR" || exit 1

while true; do
  echo "[agent-loop] Starting Claude Code in $DIR at $(date)"
  claude --dangerously-skip-permissions --channels plugin:discord@claude-plugins-official
  EXIT_CODE=$?

  # If clean exit (user typed /exit or ctrl+c), don't restart
  if [ $EXIT_CODE -eq 0 ]; then
    echo "[agent-loop] Claude Code exited cleanly. Not restarting."
    bash "$NOTIFY" "Session **$SESSION** exited cleanly. Not restarting." 2>/dev/null
    break
  fi

  # Track crash times to detect rapid crash loops
  NOW=$(date +%s)
  crash_times+=("$NOW")
  # Keep only crashes within the rapid window
  recent=()
  for t in "${crash_times[@]}"; do
    if (( NOW - t < RAPID_WINDOW )); then
      recent+=("$t")
    fi
  done
  crash_times=("${recent[@]}")

  if (( ${#crash_times[@]} >= MAX_RAPID_CRASHES )); then
    echo "[agent-loop] $MAX_RAPID_CRASHES crashes in ${RAPID_WINDOW}s. Stopping."
    bash "$NOTIFY" "Session **$SESSION** crashed $MAX_RAPID_CRASHES times in ${RAPID_WINDOW}s. Auto-restart disabled. Check the machine." 2>/dev/null
    break
  fi

  echo "[agent-loop] Claude Code exited with code $EXIT_CODE. Restarting in 5s..."
  bash "$NOTIFY" "Session **$SESSION** crashed (exit $EXIT_CODE). Restarting in 5s..." 2>/dev/null
  sleep 5
done
