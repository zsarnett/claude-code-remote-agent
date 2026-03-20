#!/bin/bash
# Send a notification to Discord.
# Usage: discord-notify.sh "message text"
# Or:    discord-notify.sh "message text" <channel-id>

MESSAGE="$1"
CHANNEL_ID="${2:-__HUB_CHANNEL_ID__}"  # default: #hub -- replace with your hub channel ID
ENV_FILE="$HOME/.claude/channels/discord/.env"

if [ -z "$MESSAGE" ]; then
  echo "Usage: discord-notify.sh <message> [channel-id]"
  exit 1
fi

BOT_TOKEN=$(grep DISCORD_BOT_TOKEN "$ENV_FILE" | cut -d= -f2-)

curl -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bot $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg msg "$MESSAGE" '{content: $msg}')" > /dev/null 2>&1
