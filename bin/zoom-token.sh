#!/bin/bash
# Returns a valid Zoom access token. Auto-refreshes if expired.
# Usage: TOKEN=$(bash ~/.claude/bin/zoom-token.sh)

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

CONFIG="$HOME/.claude/channels/zoom/config.json"
TOKEN_FILE="$HOME/.claude/channels/zoom/token.json"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "NO_TOKEN" >&2
  exit 1
fi

CLIENT_ID=$(jq -r '.client_id' "$CONFIG")
CLIENT_SECRET=$(jq -r '.client_secret' "$CONFIG")
REFRESH_TOKEN=$(jq -r '.refresh_token' "$TOKEN_FILE")
ACCESS_TOKEN=$(jq -r '.access_token' "$TOKEN_FILE")

# Test if current token works
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://api.zoom.us/v2/users/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

if [ "$STATUS" = "200" ]; then
  echo "$ACCESS_TOKEN"
  exit 0
fi

# Token expired, refresh it
AUTH=$(echo -n "${CLIENT_ID}:${CLIENT_SECRET}" | base64)
RESPONSE=$(curl -s -X POST "https://zoom.us/oauth/token" \
  -H "Authorization: Basic $AUTH" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}")

NEW_ACCESS=$(echo "$RESPONSE" | jq -r '.access_token // empty')

if [ -n "$NEW_ACCESS" ] && [ "$NEW_ACCESS" != "null" ]; then
  echo "$RESPONSE" > "$TOKEN_FILE"
  echo "$NEW_ACCESS"
else
  echo "REFRESH_FAILED" >&2
  echo "$RESPONSE" >&2
  exit 1
fi
