#!/bin/bash
# Insert an audit record into the workstation database.
# Usage: audit-log.sh <table> key1=value1 key2=value2 ...
#
# Tables: dispatches, session_runs
# Example: audit-log.sh dispatches session_name=claude-myproject runtime=claude channel_id=123
#
# Values are properly escaped via psql parameterized input.
# Runs in background to avoid blocking the caller.

TABLE="$1"
shift

if [ -z "$TABLE" ]; then
  echo "Usage: audit-log.sh <table> key1=value1 key2=value2 ..."
  exit 1
fi

PSQL="docker exec -i workstation-postgres psql -U workstation -d workstation"

# Parse key=value pairs into columns and values
COLUMNS=""
VALUES=""
for pair in "$@"; do
  KEY="${pair%%=*}"
  VAL="${pair#*=}"
  if [ -n "$COLUMNS" ]; then
    COLUMNS="$COLUMNS, $KEY"
    VALUES="$VALUES, \$\$${VAL}\$\$"
  else
    COLUMNS="$KEY"
    VALUES="\$\$${VAL}\$\$"
  fi
done

if [ -z "$COLUMNS" ]; then
  exit 0
fi

# Execute the insert (suppress errors -- audit should never block operations)
$PSQL -q -c "INSERT INTO audit.${TABLE} ($COLUMNS) VALUES ($VALUES)" 2>/dev/null || true
