#!/bin/bash
# slack-bridge.sh -- Slack-to-Discord bridge reference script
#
# This script is NOT meant to run standalone. It serves as a callable
# entry point that reminds Claude Code to perform the Slack bridge check
# using its MCP tools. When invoked, it prints the instruction path and
# exits, since the actual work requires Claude Code's Slack MCP tools.
#
# Usage:
#   slack-bridge.sh              -- print instructions for Claude Code
#   slack-bridge.sh --channels   -- list monitored channels from config
#   slack-bridge.sh --config     -- print the full config

CONFIG_FILE="$HOME/.claude/channels/slack/config.json"
INSTRUCTIONS="$HOME/.claude/bin/slack-bridge-instructions.md"
NOTIFY_SCRIPT="$HOME/.claude/bin/discord-notify.sh"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config file not found at $CONFIG_FILE"
  exit 1
fi

case "${1:-}" in
  --channels)
    echo "Monitored Slack channels:"
    jq -r '.channels_to_monitor[] | "  - #\(.name) (priority: \(.priority))"' "$CONFIG_FILE"
    ;;
  --config)
    cat "$CONFIG_FILE"
    ;;
  --notify)
    # Helper: forward a formatted message to Discord #hub
    # Usage: slack-bridge.sh --notify "#channel" "sender" "message text"
    CHANNEL="${2:-unknown}"
    SENDER="${3:-unknown}"
    MSG="${4:-}"
    if [ -z "$MSG" ]; then
      echo "Usage: slack-bridge.sh --notify <channel> <sender> <message>"
      exit 1
    fi
    PREFIX=$(jq -r '.formatting.prefix' "$CONFIG_FILE")
    DISCORD_CHANNEL=$(jq -r '.discord_hub_channel_id' "$CONFIG_FILE")
    FORMATTED="${PREFIX} ${CHANNEL} | ${SENDER}: ${MSG}"
    # Truncate if needed
    MAX_LEN=$(jq -r '.formatting.max_message_length' "$CONFIG_FILE")
    if [ ${#FORMATTED} -gt "$MAX_LEN" ]; then
      FORMATTED="${FORMATTED:0:$MAX_LEN}..."
    fi
    "$NOTIFY_SCRIPT" "$FORMATTED" "$DISCORD_CHANNEL"
    echo "Forwarded to Discord #hub"
    ;;
  --help)
    echo "slack-bridge.sh -- Slack-to-Discord bridge for Claude Code"
    echo ""
    echo "Commands:"
    echo "  (no args)    Print bridge instructions for Claude Code"
    echo "  --channels   List monitored Slack channels"
    echo "  --config     Print full config JSON"
    echo "  --notify     Forward a message to Discord (used by Claude Code)"
    echo "               Usage: slack-bridge.sh --notify <channel> <sender> <message>"
    echo "  --help       Show this help"
    ;;
  *)
    echo "=== Slack-to-Discord Bridge ==="
    echo ""
    echo "This bridge requires Claude Code with Slack MCP tools."
    echo "Instructions: $INSTRUCTIONS"
    echo "Config: $CONFIG_FILE"
    echo ""
    echo "To run a bridge check, ask Claude Code:"
    echo "  'Check Slack and forward important messages to Discord'"
    echo ""
    echo "Or use the --notify flag to forward a specific message:"
    echo "  slack-bridge.sh --notify '#general' 'Alice' 'Hey Zack, need your review'"
    ;;
esac
