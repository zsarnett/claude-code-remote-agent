#!/bin/bash
# Send a notification to a Discord channel with optional file attachments.
# Usage: discord-notify.sh "message text" [channel-id] [file1] [file2] ...
#
# Examples:
#   discord-notify.sh "hello"                          # text to #hub
#   discord-notify.sh "hello" 12345                    # text to specific channel
#   discord-notify.sh "screenshot" "" /tmp/shot.png    # file to channel from env/tmux
#   discord-notify.sh "results" 12345 /tmp/a.png /tmp/b.png  # text + files

MESSAGE="$1"
shift

# Second arg is channel ID (may be empty string to use env/tmux default)
EXPLICIT_CHANNEL="$1"
if [ -n "$EXPLICIT_CHANNEL" ] && [[ "$EXPLICIT_CHANNEL" =~ ^[0-9]+$ ]]; then
  CHANNEL_ID="$EXPLICIT_CHANNEL"
  shift
else
  # Not a channel ID -- might be a file path, put it back
  if [ -n "$EXPLICIT_CHANNEL" ] && [ -f "$EXPLICIT_CHANNEL" ]; then
    set -- "$EXPLICIT_CHANNEL" "$@"
  elif [ -n "$EXPLICIT_CHANNEL" ] && [ "$EXPLICIT_CHANNEL" != "" ]; then
    set -- "$EXPLICIT_CHANNEL" "$@"
  else
    shift  # was empty string, skip it
  fi
fi

# Resolve channel ID from env or tmux if not set
if [ -z "$CHANNEL_ID" ]; then
  if [ -n "$DISCORD_CHANNEL_ID" ]; then
    CHANNEL_ID="$DISCORD_CHANNEL_ID"
  else
    TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null)
    if [ -n "$TMUX_SESSION" ]; then
      CHANNEL_ID=$(tmux show-environment -t "$TMUX_SESSION" DISCORD_CHANNEL_ID 2>/dev/null | cut -d= -f2-)
    fi
  fi
fi

CHANNEL_ID="${CHANNEL_ID:-1484594218323283989}"  # fallback to #hub
ENV_FILE="$HOME/.claude/channels/discord/.env"

if [ -z "$MESSAGE" ]; then
  echo "Usage: discord-notify.sh <message> [channel-id] [file1] [file2] ..."
  exit 1
fi

BOT_TOKEN=$(grep DISCORD_BOT_TOKEN "$ENV_FILE" | cut -d= -f2-)

# Collect file arguments
FILES=()
for arg in "$@"; do
  if [ -f "$arg" ]; then
    FILES+=("$arg")
  fi
done

MAX_LEN=1900

send_text() {
  local msg="$1"
  curl -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
    -H "Authorization: Bot $BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$msg" '{content: $msg}')" > /dev/null 2>&1
}

send_chunks() {
  local remaining="$1"
  while [ ${#remaining} -gt $MAX_LEN ]; do
    local chunk="${remaining:0:$MAX_LEN}"
    # Find the last newline within the chunk to split cleanly
    local nl_pos=-1
    local i=${#chunk}
    while [ $i -gt 0 ]; do
      i=$((i - 1))
      if [ "${chunk:$i:1}" = $'\n' ]; then
        nl_pos=$i
        break
      fi
    done
    if [ $nl_pos -gt 0 ]; then
      send_text "${remaining:0:$nl_pos}"
      remaining="${remaining:$((nl_pos + 1))}"
    else
      # No newline found -- hard cut at MAX_LEN
      send_text "$chunk"
      remaining="${remaining:$MAX_LEN}"
    fi
    sleep 0.3  # respect rate limits
  done
  if [ -n "$remaining" ]; then
    send_text "$remaining"
  fi
}

if [ ${#FILES[@]} -eq 0 ]; then
  # Text-only message -- auto-split if needed
  send_chunks "$MESSAGE"
else
  # Message with file attachments -- split text, attach files to last chunk
  if [ ${#MESSAGE} -le $MAX_LEN ]; then
    # Fits in one message, send with attachments
    CURL_ARGS=(
      -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages"
      -H "Authorization: Bot $BOT_TOKEN"
      -F "payload_json=$(jq -n --arg msg "$MESSAGE" '{content: $msg}')"
    )
    for i in "${!FILES[@]}"; do
      CURL_ARGS+=(-F "files[$i]=@${FILES[$i]}")
    done
    curl "${CURL_ARGS[@]}" > /dev/null 2>&1
  else
    # Send text chunks first, then files with the last chunk
    _remaining="$MESSAGE"
    while [ ${#_remaining} -gt $MAX_LEN ]; do
      _chunk="${_remaining:0:$MAX_LEN}"
      _nl_pos=-1
      _i=${#_chunk}
      while [ $_i -gt 0 ]; do
        _i=$((_i - 1))
        if [ "${_chunk:$_i:1}" = $'\n' ]; then
          _nl_pos=$_i
          break
        fi
      done
      if [ $_nl_pos -gt 0 ]; then
        send_text "${_remaining:0:$_nl_pos}"
        _remaining="${_remaining:$((_nl_pos + 1))}"
      else
        send_text "$_chunk"
        _remaining="${_remaining:$MAX_LEN}"
      fi
      sleep 0.3
    done
    # Last chunk goes with the file attachments
    CURL_ARGS=(
      -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages"
      -H "Authorization: Bot $BOT_TOKEN"
      -F "payload_json=$(jq -n --arg msg "$_remaining" '{content: $msg}')"
    )
    for i in "${!FILES[@]}"; do
      CURL_ARGS+=(-F "files[$i]=@${FILES[$i]}")
    done
    curl "${CURL_ARGS[@]}" > /dev/null 2>&1
  fi
fi
