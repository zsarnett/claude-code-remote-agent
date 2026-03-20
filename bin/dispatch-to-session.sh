#!/bin/bash
# Dispatches a Discord message to a dedicated project tmux session.
# Sets DISCORD_CHANNEL_ID env var so the Stop hook auto-posts to Discord.
#
# Usage: dispatch-to-session.sh <session-name> <project-dir> <discord-channel-id> <message>

NAME="$1"
SESSION_NAME="claude-$NAME"
PROJECT_DIR="$2"
CHANNEL_ID="$3"
MESSAGE="$4"

if [ -z "$NAME" ] || [ -z "$PROJECT_DIR" ] || [ -z "$CHANNEL_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: dispatch-to-session.sh <name> <dir> <channel-id> <message>"
  exit 1
fi

# Create session if it doesn't exist
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  # Launch with DISCORD_CHANNEL_ID so the Stop hook knows where to post
  tmux new-session -d -s "$SESSION_NAME" -c "$PROJECT_DIR" \
    "DISCORD_CHANNEL_ID=$CHANNEL_ID claude --dangerously-skip-permissions"
  sleep 5
fi

# Send the message
tmux send-keys -t "$SESSION_NAME" "$MESSAGE" Enter

echo "Dispatched to $SESSION_NAME"
