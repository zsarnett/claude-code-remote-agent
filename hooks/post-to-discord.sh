#!/bin/bash
# Stop hook: automatically posts Claude's response to Discord.
# Only fires when DISCORD_CHANNEL_ID is set (project sessions only, not hub).

# If DISCORD_CHANNEL_ID not in env, try to get it from the tmux session
if [ -z "$DISCORD_CHANNEL_ID" ]; then
  # Find which tmux session we're in
  TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null)
  if [ -n "$TMUX_SESSION" ]; then
    DISCORD_CHANNEL_ID=$(tmux show-environment -t "$TMUX_SESSION" DISCORD_CHANNEL_ID 2>/dev/null | cut -d= -f2-)
  fi
fi

# Debug: log what channel ID we're seeing
echo "$(date) STOP_HOOK DISCORD_CHANNEL_ID=${DISCORD_CHANNEL_ID:-EMPTY}" >> ~/.claude/logs/hook-debug.log

if [ -z "$DISCORD_CHANNEL_ID" ]; then
  exit 0
fi

INPUT=$(cat)

# Extract from last_assistant_message field
RESPONSE=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null | head -c 1900)

if [ -n "$RESPONSE" ] && [ "$RESPONSE" != "null" ]; then
  bash ~/.claude/bin/discord-notify.sh "$RESPONSE" "$DISCORD_CHANNEL_ID" || true
fi

exit 0
