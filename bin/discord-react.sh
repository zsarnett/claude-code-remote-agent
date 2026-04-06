#!/bin/bash
# Add or remove a Discord emoji reaction on a message.
# Usage: discord-react.sh <add|remove> <channel-id> <message-id> <emoji>
#
# Emoji names: eyes, brain, white_check_mark, x
# Uses URL-encoded emoji format for the Discord API.

ACTION="$1"
CHANNEL_ID="$2"
MESSAGE_ID="$3"
EMOJI="$4"

if [ -z "$ACTION" ] || [ -z "$CHANNEL_ID" ] || [ -z "$MESSAGE_ID" ] || [ -z "$EMOJI" ]; then
  echo "Usage: discord-react.sh <add|remove> <channel-id> <message-id> <emoji>"
  exit 1
fi

ENV_FILE="$HOME/.claude/channels/discord/.env"
BOT_TOKEN=$(grep DISCORD_BOT_TOKEN "$ENV_FILE" | cut -d= -f2-)

if [ -z "$BOT_TOKEN" ]; then
  echo "Error: DISCORD_BOT_TOKEN not found in $ENV_FILE"
  exit 1
fi

# Map emoji names to URL-encoded Unicode
case "$EMOJI" in
  eyes)              ENCODED="%F0%9F%91%80" ;;
  brain)             ENCODED="%F0%9F%A7%A0" ;;
  white_check_mark)  ENCODED="%E2%9C%85" ;;
  x)                 ENCODED="%E2%9D%8C" ;;
  *)                 ENCODED="$EMOJI" ;;
esac

API_BASE="https://discord.com/api/v10/channels/$CHANNEL_ID/messages/$MESSAGE_ID/reactions/$ENCODED/@me"

case "$ACTION" in
  add)
    curl -s -X PUT "$API_BASE" \
      -H "Authorization: Bot $BOT_TOKEN" \
      -H "Content-Length: 0" > /dev/null 2>&1
    ;;
  remove)
    curl -s -X DELETE "$API_BASE" \
      -H "Authorization: Bot $BOT_TOKEN" > /dev/null 2>&1
    ;;
  *)
    echo "Error: action must be 'add' or 'remove', got '$ACTION'"
    exit 1
    ;;
esac
