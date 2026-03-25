#!/bin/bash
# Dispatches a Discord message to a dedicated project tmux session.
# Writes message to a temp file, uses tmux load-buffer + paste to avoid send-keys issues.
# Sets DISCORD_CHANNEL_ID env var so the Stop hook auto-posts to Discord.
#
# Usage: dispatch-to-session.sh <session-name> <project-dir> <discord-channel-id> <message> [agent-name]
# agent-name is optional -- if provided, starts claude with --agent <agent-name>

NAME="$1"
SESSION_NAME="claude-$NAME"
PROJECT_DIR="$2"
CHANNEL_ID="$3"
MESSAGE="$4"
AGENT="$5"

if [ -z "$NAME" ] || [ -z "$PROJECT_DIR" ] || [ -z "$CHANNEL_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: dispatch-to-session.sh <name> <dir> <channel-id> <message> [agent-name]"
  exit 1
fi

# Build the claude command with optional agent flag
CLAUDE_CMD="claude --dangerously-skip-permissions"
if [ -n "$AGENT" ]; then
  CLAUDE_CMD="claude --agent $AGENT --dangerously-skip-permissions"
fi

# Create session if it doesn't exist
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  # Inject Discord communication instructions into the project
  DISCORD_INSTRUCTIONS="$HOME/Documents/ZacksWorkspace/agent-scripts/discord-session-instructions.md"
  if [ -f "$DISCORD_INSTRUCTIONS" ]; then
    mkdir -p "$PROJECT_DIR/.claude/rules"
    cp "$DISCORD_INSTRUCTIONS" "$PROJECT_DIR/.claude/rules/discord.md"
  fi

  # Export DISCORD_CHANNEL_ID so it persists across restarts via agent-loop.
  # Use tmux set-environment so child processes always inherit it.
  tmux new-session -d -s "$SESSION_NAME" -c "$PROJECT_DIR" \
    "export DISCORD_CHANNEL_ID=$CHANNEL_ID; $CLAUDE_CMD"
  tmux set-environment -t "$SESSION_NAME" DISCORD_CHANNEL_ID "$CHANNEL_ID"
  sleep 5
fi

# Auto-inject last checkpoint/handoff context from memory system
# Only inject on new session creation (not for messages to existing sessions)
WAKE_SCRIPT="$HOME/.claude/bin/memory-wake-inject.sh"
CONTEXT=""
if [ -x "$WAKE_SCRIPT" ]; then
  CONTEXT=$("$WAKE_SCRIPT" "$NAME" 2>/dev/null)
fi

# Build the full message with optional context injection
FULL_MESSAGE="$MESSAGE"
if [ -n "$CONTEXT" ]; then
  FULL_MESSAGE="$CONTEXT

$MESSAGE"
fi

# Write message to temp file, flatten to single line, send via tmux
# Using a temp file + tmux load-buffer + paste-buffer avoids all quoting issues
MSG_FILE=$(mktemp /tmp/claude-msg-XXXXXX)
echo "$FULL_MESSAGE" | tr '\n' ' ' | sed 's/  */ /g' > "$MSG_FILE"

# Load into tmux buffer and paste it into the session, then send Enter
tmux load-buffer "$MSG_FILE"
tmux paste-buffer -t "$SESSION_NAME"
sleep 1
tmux send-keys -t "$SESSION_NAME" Enter
sleep 0.3
# Double-tap Enter in case the first one was absorbed by a UI element (e.g., image preview)
tmux send-keys -t "$SESSION_NAME" Enter

rm -f "$MSG_FILE"

echo "Dispatched to $SESSION_NAME (agent: ${AGENT:-default})"
