#!/bin/bash
# Auto-restart wrapper for Claude Code sessions.
# If Claude exits (crash, OOM, etc.), waits 5 seconds and restarts.
# Sends a Discord notification on crash and restart.

SESSION="$1"
DIR="$2"
CHANNEL_ID="$3"  # Discord channel ID for this session's notifications
AGENT="$4"       # Optional agent definition name (e.g., "hub")
NOTIFY="$HOME/.claude/bin/discord-notify.sh"
MAX_RAPID_CRASHES=5
RAPID_WINDOW=60  # seconds
crash_times=()

cd "$DIR" || exit 1

while true; do
  echo "[agent-loop] Starting Claude Code in $DIR at $(date)"
  # Ensure DISCORD_CHANNEL_ID is exported for Stop hook auto-posting
  if [ -n "$CHANNEL_ID" ]; then
    export DISCORD_CHANNEL_ID="$CHANNEL_ID"
  fi
  # Only the hub (claude-agent) should connect to Discord channels.
  CLAUDE_CMD="claude --dangerously-skip-permissions"
  if [ -n "$AGENT" ]; then
    CLAUDE_CMD="claude --agent $AGENT --dangerously-skip-permissions"
  fi
  if [ "$SESSION" = "claude-agent" ]; then
    CLAUDE_CMD="$CLAUDE_CMD --channels plugin:discord@claude-plugins-official"

    # Start a watchdog that monitors the Discord bun process.
    # If Claude's idle MCP pruning kills it, the watchdog sends SIGTERM to
    # Claude so the agent-loop restarts the session with a fresh plugin.
    (
      sleep 30  # give Claude time to start and spawn the plugin
      CLAUDE_PID=$!
      # Find the Claude process for this session
      CLAUDE_PID=$(pgrep -P $$ -f "claude.*--dangerously" 2>/dev/null | head -1)
      while kill -0 "$CLAUDE_PID" 2>/dev/null; do
        # Check if any bun discord process exists in our process group
        PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
        HAS_DISCORD=$(ps -eo pid,pgid,command 2>/dev/null | awk -v pg="$PGID" '$2 == pg' | grep -c "bun.*discord")
        if [ "$HAS_DISCORD" -eq 0 ]; then
          echo "[agent-loop] Discord plugin died. Restarting hub..."
          kill "$CLAUDE_PID" 2>/dev/null
          break
        fi
        sleep 30
      done
    ) &
    WATCHDOG_PID=$!
  fi
  $CLAUDE_CMD
  EXIT_CODE=$?

  # Kill the watchdog if it's still running
  kill "$WATCHDOG_PID" 2>/dev/null

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
    bash "$HOME/.claude/bin/audit-log.sh" session_runs \
      session_name="$SESSION" runtime=claude stop_reason="rapid-crash-loop" 2>/dev/null &
    break
  fi

  echo "[agent-loop] Claude Code exited with code $EXIT_CODE. Restarting in 5s..."
  bash "$NOTIFY" "Session **$SESSION** crashed (exit $EXIT_CODE). Restarting in 5s..." 2>/dev/null
  # Swap brain to x reaction on crash
  REACT="$HOME/.claude/bin/discord-react.sh"
  MSG_ID=$(tmux show-environment -t "$SESSION" DISCORD_MESSAGE_ID 2>/dev/null | cut -d= -f2- || echo "")
  CH_ID=$(tmux show-environment -t "$SESSION" DISCORD_CHANNEL_ID 2>/dev/null | cut -d= -f2- || echo "")
  if [ -n "$MSG_ID" ] && [ -n "$CH_ID" ]; then
    bash "$REACT" remove "$CH_ID" "$MSG_ID" brain 2>/dev/null &
    bash "$REACT" add "$CH_ID" "$MSG_ID" x 2>/dev/null &
  fi
  # Log crash to audit
  bash "$HOME/.claude/bin/audit-log.sh" session_runs \
    session_name="$SESSION" runtime=claude stop_reason=crashed 2>/dev/null &
  sleep 5
done
