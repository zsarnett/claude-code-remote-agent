#!/bin/bash
# List tasks from the workstation task board.
# Usage: task-list.sh [--session NAME] [--status STATUS] [--parent ID] [--all]

SESSION_FILTER=""
STATUS_FILTER=""
PARENT_FILTER=""
SHOW_ALL=false

while [ $# -gt 0 ]; do
  case "$1" in
    --session) SESSION_FILTER="$2"; shift 2 ;;
    --status) STATUS_FILTER="$2"; shift 2 ;;
    --parent) PARENT_FILTER="$2"; shift 2 ;;
    --all) SHOW_ALL=true; shift ;;
    *) shift ;;
  esac
done

PSQL="docker exec -i workstation-postgres psql -U workstation -d workstation"

# Build WHERE clauses
WHERE="WHERE 1=1"
if [ -n "$SESSION_FILTER" ]; then
  WHERE="$WHERE AND session_name = '$SESSION_FILTER'"
fi
if [ -n "$STATUS_FILTER" ]; then
  WHERE="$WHERE AND status = '$STATUS_FILTER'"
elif [ "$SHOW_ALL" = false ]; then
  WHERE="$WHERE AND status != 'done'"
fi
if [ -n "$PARENT_FILTER" ]; then
  WHERE="$WHERE AND parent_id = $PARENT_FILTER"
fi

$PSQL -c "
  SELECT
    id AS \"#\",
    CASE status
      WHEN 'pending' THEN 'PEND'
      WHEN 'in_progress' THEN 'PROG'
      WHEN 'done' THEN 'DONE'
      WHEN 'stalled' THEN 'STAL'
    END AS st,
    LEFT(title, 60) AS title,
    COALESCE(session_name, '-') AS session,
    to_char(age(now(), created_at), 'HH24h FMMMm') AS age
  FROM tasks.items
  $WHERE
  ORDER BY
    CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'stalled' THEN 2 ELSE 3 END,
    updated_at DESC
  LIMIT 50;
" 2>/dev/null
