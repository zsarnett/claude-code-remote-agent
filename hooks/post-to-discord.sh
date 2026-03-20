#!/bin/bash
# Stop hook: automatically posts Claude's response to Discord.
# Only fires when DISCORD_CHANNEL_ID is set (project sessions only, not hub).

if [ -z "$DISCORD_CHANNEL_ID" ]; then
  exit 0
fi

INPUT=$(cat)

# Extract from last_assistant_message field
RESPONSE=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null | head -c 1900)

if [ -n "$RESPONSE" ] && [ "$RESPONSE" != "null" ]; then
  bash ~/.claude/bin/discord-notify.sh "$RESPONSE" "$DISCORD_CHANNEL_ID"
fi
