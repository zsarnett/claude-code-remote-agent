#!/bin/bash
# Creates a Discord text channel in the configured guild and registers it in the channel map.
#
# Usage: discord-create-channel.sh <channel-name> <project-dir>
# Example: discord-create-channel.sh nymblpresent /Users/YOUR_USER/Documents/NYMBLPresent

set -e

CHANNEL_NAME="$1"
PROJECT_DIR="$2"
ENV_FILE="$HOME/.claude/channels/discord/.env"
MAP_FILE="$HOME/.claude/channels/discord/channel-map.json"
ACCESS_FILE="$HOME/.claude/channels/discord/access.json"

if [ -z "$CHANNEL_NAME" ] || [ -z "$PROJECT_DIR" ]; then
  echo "Usage: discord-create-channel.sh <channel-name> <project-dir>"
  exit 1
fi

# Load bot token
BOT_TOKEN=$(grep DISCORD_BOT_TOKEN "$ENV_FILE" | cut -d= -f2-)

# Load guild ID and category ID
GUILD_ID=$(jq -r '.guildId' "$MAP_FILE")
CATEGORY_ID=$(jq -r '.categoryId // empty' "$MAP_FILE")
if [ -z "$GUILD_ID" ] || [ "$GUILD_ID" = "" ]; then
  echo "Error: guildId not set in $MAP_FILE"
  exit 1
fi

# IDs for permissions
BOT_ID="1484588834250293349"
ZACK_ID="245593460403339264"
EVERYONE_ROLE_ID="$GUILD_ID"  # @everyone role ID = guild ID

# Build request body with private permissions by default
BODY=$(jq -n \
  --arg name "$CHANNEL_NAME" \
  --arg parent "$CATEGORY_ID" \
  --arg everyone "$EVERYONE_ROLE_ID" \
  --arg zack "$ZACK_ID" \
  --arg bot "$BOT_ID" \
  '{
    name: $name,
    type: 0,
    parent_id: $parent,
    permission_overwrites: [
      {id: $everyone, type: 0, deny: "1024", allow: "0"},
      {id: $zack, type: 1, deny: "0", allow: "1024"},
      {id: $bot, type: 1, deny: "0", allow: "1024"}
    ]
  }')

# Create channel via Discord API
RESPONSE=$(curl -s -X POST "https://discord.com/api/v10/guilds/$GUILD_ID/channels" \
  -H "Authorization: Bot $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" 2>/dev/null)

CHANNEL_ID=$(echo "$RESPONSE" | jq -r '.id // empty')

if [ -z "$CHANNEL_ID" ]; then
  echo "Error creating channel: $RESPONSE"
  exit 1
fi

# Update channel map
jq --arg name "$CHANNEL_NAME" --arg id "$CHANNEL_ID" --arg dir "$PROJECT_DIR" \
  '.channels[$id] = {"name": $name, "dir": $dir}' "$MAP_FILE" > "$MAP_FILE.tmp" \
  && mv "$MAP_FILE.tmp" "$MAP_FILE"

# Register in access.json as a group channel
jq --arg id "$CHANNEL_ID" \
  '.groups[$id] = {"requireMention": false, "allowFrom": ["245593460403339264"]}' "$ACCESS_FILE" > "$ACCESS_FILE.tmp" \
  && mv "$ACCESS_FILE.tmp" "$ACCESS_FILE"

# Copy standard MCP config if project doesn't already have one
STANDARD_MCP="$HOME/Documents/ZacksWorkspace/agent-scripts/standard-mcp.json"
if [ ! -f "$PROJECT_DIR/.mcp.json" ] && [ -f "$STANDARD_MCP" ]; then
  cp "$STANDARD_MCP" "$PROJECT_DIR/.mcp.json"
fi

echo "$CHANNEL_ID"
