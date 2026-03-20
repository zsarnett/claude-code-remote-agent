#!/bin/bash
# Kills a project session and optionally notifies Discord.
# Used for "clear context" / "fresh start" on a specific project.
#
# Usage: kill-project-session.sh <session-name> [channel-id]

SESSION_NAME="claude-$1"
CHANNEL_ID="$2"
NOTIFY="$HOME/.claude/bin/discord-notify.sh"

if [ -z "$1" ]; then
  echo "Usage: kill-project-session.sh <name> [channel-id]"
  exit 1
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
  echo "Killed $SESSION_NAME"
  if [ -n "$CHANNEL_ID" ]; then
    bash "$NOTIFY" "Session cleared. Next message will start a fresh context." "$CHANNEL_ID"
  fi
else
  echo "No session $SESSION_NAME"
fi
