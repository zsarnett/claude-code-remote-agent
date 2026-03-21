#!/bin/bash
# Dispatches a Discord message to a dedicated project tmux session.
# Writes message to a temp file, uses tmux load-buffer + paste to avoid send-keys issues.
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
  tmux new-session -d -s "$SESSION_NAME" -c "$PROJECT_DIR" \
    "DISCORD_CHANNEL_ID=$CHANNEL_ID claude --dangerously-skip-permissions"
  sleep 5
fi

# Write message to temp file, flatten to single line, send via tmux
# Using a temp file + tmux load-buffer + paste-buffer avoids all quoting issues
MSG_FILE=$(mktemp /tmp/claude-msg-XXXXXX)
echo "$MESSAGE" | tr '\n' ' ' | sed 's/  */ /g' > "$MSG_FILE"

# Load into tmux buffer and paste it into the session, then send Enter
tmux load-buffer "$MSG_FILE"
tmux paste-buffer -t "$SESSION_NAME"
sleep 0.5
tmux send-keys -t "$SESSION_NAME" Enter

rm -f "$MSG_FILE"

echo "Dispatched to $SESSION_NAME"
