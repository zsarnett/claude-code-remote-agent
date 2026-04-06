#!/bin/bash
# Apply pending SQL migrations from agent-scripts/db/migrations/.
# Tracks applied migrations in the public._migrations table.
# Usage: db-migrate.sh

set -euo pipefail

DB_URL="${WORKSTATION_DB_URL:-postgresql://workstation:workstation@localhost:5433/workstation}"
MIGRATIONS_DIR="$(dirname "$0")/migrations"
PSQL="docker exec -i workstation-postgres psql -U workstation -d workstation"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "No migrations directory found at $MIGRATIONS_DIR"
  exit 0
fi

# Get list of already-applied migrations
APPLIED=$($PSQL -t -A -c "SELECT filename FROM public._migrations ORDER BY filename" 2>/dev/null || echo "")

# Apply each migration file in order
for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue
  FILENAME=$(basename "$migration")

  if echo "$APPLIED" | grep -qF "$FILENAME"; then
    continue
  fi

  echo "Applying migration: $FILENAME"
  cat "$migration" | $PSQL
  $PSQL -c "INSERT INTO public._migrations (filename) VALUES ('$FILENAME')"
  echo "Applied: $FILENAME"
done

echo "All migrations up to date."
