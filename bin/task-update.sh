#!/bin/bash
# Update a task in the workstation task board.
# Usage: task-update.sh ID [--status STATUS] [--title "title"] [--description "desc"] [--session NAME]

TASK_ID="$1"
shift

if [ -z "$TASK_ID" ]; then
  echo "Usage: task-update.sh ID [--status STATUS] [--title \"title\"] [--description \"desc\"]" >&2
  exit 1
fi

PSQL="docker exec -i workstation-postgres psql -U workstation -d workstation -t -A -q"

# Build SET clauses
SET_CLAUSES="updated_at = now()"
while [ $# -gt 0 ]; do
  case "$1" in
    --status)
      SET_CLAUSES="$SET_CLAUSES, status = '$(echo "$2" | sed "s/'/''/g")'"; shift 2 ;;
    --title)
      SET_CLAUSES="$SET_CLAUSES, title = '$(echo "$2" | sed "s/'/''/g")'"; shift 2 ;;
    --description)
      SET_CLAUSES="$SET_CLAUSES, description = '$(echo "$2" | sed "s/'/''/g")'"; shift 2 ;;
    --session)
      SET_CLAUSES="$SET_CLAUSES, session_name = '$(echo "$2" | sed "s/'/''/g")'"; shift 2 ;;
    *) shift ;;
  esac
done

RESULT=$($PSQL -c "
  UPDATE tasks.items SET $SET_CLAUSES WHERE id = $TASK_ID
  RETURNING id, status, title;
" 2>/dev/null)

if [ -n "$RESULT" ]; then
  echo "Updated task #$TASK_ID: $RESULT"
else
  echo "Task #$TASK_ID not found" >&2
  exit 1
fi
