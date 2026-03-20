#!/bin/bash
# Health check -- verifies Claude Code agent sessions are running.
# Sends a Discord alert if the main session is down.
# Intended to run via cron every 5 minutes.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

NOTIFY="$HOME/.claude/bin/discord-notify.sh"
AGENT_SCRIPT="$HOME/.claude/start-agent.sh"
LOCKFILE="/tmp/claude-agent-restarting.lock"

# Skip if a restart is in progress (lockfile less than 60 seconds old)
if [ -f "$LOCKFILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f%m "$LOCKFILE") ))
  if (( LOCK_AGE < 60 )); then
    exit 0
  fi
  rm -f "$LOCKFILE"
fi

# Check if main agent session exists
if ! tmux has-session -t claude-agent 2>/dev/null; then
  touch "$LOCKFILE"
  bash "$NOTIFY" "**ALERT:** Main agent session (claude-agent) is down. Attempting restart..."
  bash "$AGENT_SCRIPT"
  sleep 10
  if tmux has-session -t claude-agent 2>/dev/null; then
    bash "$NOTIFY" "Main agent session restarted successfully."
  else
    bash "$NOTIFY" "**FAILED** to restart main agent session. Manual intervention needed."
  fi
  rm -f "$LOCKFILE"
fi
