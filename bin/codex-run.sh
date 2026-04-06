#!/bin/bash
# Wrapper that runs Codex CLI and posts the final result to Discord.
# Designed to be called from within a tmux session where DISCORD_CHANNEL_ID is set.
#
# Usage: codex-run.sh <project-dir> <message>
#
# Uses `codex exec --full-auto -o <file>` to capture only the agent's final
# message (not intermediate tool calls or reasoning). Posts that single result
# to Discord when done.

PROJECT_DIR="$1"
MESSAGE="$2"
NOTIFY="$HOME/.claude/bin/discord-notify.sh"
CODEX_BIN="/opt/homebrew/bin/codex"
CHANNEL_ID="${DISCORD_CHANNEL_ID}"

if [ -z "$PROJECT_DIR" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: codex-run.sh <project-dir> <message>"
  exit 1
fi

if [ -z "$CHANNEL_ID" ]; then
  echo "Error: DISCORD_CHANNEL_ID not set"
  exit 1
fi

# Post start notification
bash "$NOTIFY" "**Codex running...**
\`$(basename "$PROJECT_DIR")\`: ${MESSAGE:0:200}$([ ${#MESSAGE} -gt 200 ] && echo '...')" "$CHANNEL_ID"

# Run codex. -o captures only the final agent message (no intermediate output).
RESULT_FILE=$(mktemp /tmp/codex-result-XXXXXX)
cd "$PROJECT_DIR" || exit 1

$CODEX_BIN exec --full-auto -C "$PROJECT_DIR" -o "$RESULT_FILE" "$MESSAGE" > /dev/null 2>&1
EXIT_CODE=$?

RESULT=$(cat "$RESULT_FILE")
RESULT_BYTES=$(wc -c < "$RESULT_FILE")

if [ $EXIT_CODE -eq 0 ]; then
  HEADER="**Codex done**"
else
  HEADER="**Codex failed (exit $EXIT_CODE)**"
fi

if [ -z "$RESULT" ]; then
  bash "$NOTIFY" "$HEADER -- no output" "$CHANNEL_ID"
elif [ "$RESULT_BYTES" -le 1800 ]; then
  bash "$NOTIFY" "$HEADER
$RESULT" "$CHANNEL_ID"
else
  # Final message too long for one Discord message -- post summary + file
  SUMMARY=$(echo "$RESULT" | head -30)
  bash "$NOTIFY" "$HEADER (full output attached)
$SUMMARY" "$CHANNEL_ID" "$RESULT_FILE"
fi

rm -f "$RESULT_FILE"
