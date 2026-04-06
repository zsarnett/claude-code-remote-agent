#!/bin/bash
# Create a task in the workstation task board.
# Usage: task-create.sh "title" [--description "desc"] [--parent ID] [--session NAME] [--status STATUS]
# Outputs the created task ID to stdout.

TITLE=""
DESCRIPTION=""
PARENT_ID=""
SESSION_NAME=""
STATUS="pending"
CHANNEL_ID="${DISCORD_CHANNEL_ID:-}"

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --description) DESCRIPTION="$2"; shift 2 ;;
    --parent) PARENT_ID="$2"; shift 2 ;;
    --session) SESSION_NAME="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    --channel) CHANNEL_ID="$2"; shift 2 ;;
    *)
      if [ -z "$TITLE" ]; then
        TITLE="$1"
      fi
      shift ;;
  esac
done

if [ -z "$TITLE" ]; then
  echo "Usage: task-create.sh \"title\" [--description \"desc\"] [--parent ID] [--session NAME] [--status STATUS]" >&2
  exit 1
fi

# Auto-detect session name from tmux if not provided
if [ -z "$SESSION_NAME" ]; then
  SESSION_NAME=$(tmux display-message -p '#S' 2>/dev/null || echo "")
fi

PSQL="docker exec -i workstation-postgres psql -U workstation -d workstation -t -A -q"

# Build SQL
ESCAPED_TITLE=$(echo "$TITLE" | sed "s/'/''/g")
ESCAPED_DESC=$(echo "$DESCRIPTION" | sed "s/'/''/g")
PARENT_VAL="NULL"
if [ -n "$PARENT_ID" ]; then
  PARENT_VAL="$PARENT_ID"
fi

TASK_ID=$($PSQL -c "
  INSERT INTO tasks.items (title, description, status, session_name, channel_id, parent_id)
  VALUES ('$ESCAPED_TITLE', NULLIF('$ESCAPED_DESC',''), '$STATUS', NULLIF('$SESSION_NAME',''), NULLIF('$CHANNEL_ID',''), $PARENT_VAL)
  RETURNING id;
" 2>/dev/null)

if [ -n "$TASK_ID" ]; then
  echo "$TASK_ID"
else
  echo "Failed to create task" >&2
  exit 1
fi
