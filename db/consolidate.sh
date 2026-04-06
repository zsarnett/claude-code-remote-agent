#!/bin/bash
# Nightly consolidation for the workstation memory system.
# Run via cron: 0 3 * * * bash ~/Documents/ZacksWorkspace/agent-scripts/db/consolidate.sh
#
# Actions:
# 1. Compress episodes older than 7 days (trim tools_used, files_touched)
# 2. Prune superseded facts older than 30 days
# 3. Post digest to Discord hub channel

set -euo pipefail

NOTIFY="$HOME/.claude/bin/discord-notify.sh"
HUB_CHANNEL="1484594218323283989"
PSQL="docker exec -i workstation-postgres psql -U workstation -d workstation"

# Check if Postgres is reachable
if ! docker exec workstation-postgres psql -U workstation -d workstation -c "SELECT 1" > /dev/null 2>&1; then
  exit 0
fi

# 1. Compress old episodes: clear arrays on episodes older than 7 days
COMPRESSED=$($PSQL -t -A -c "
  UPDATE memory.episodes
  SET tools_used = NULL, files_touched = NULL
  WHERE created_at < now() - interval '7 days'
    AND tools_used IS NOT NULL
  RETURNING id
" 2>/dev/null | wc -l | tr -d ' ')

# 2. Prune superseded facts older than 30 days
PRUNED=$($PSQL -t -A -c "
  DELETE FROM memory.facts
  WHERE superseded_by IS NOT NULL
    AND superseded_at < now() - interval '30 days'
  RETURNING id
" 2>/dev/null | wc -l | tr -d ' ')

# 3. Count totals for digest
TOTAL_EPISODES=$($PSQL -t -A -c "SELECT COUNT(*) FROM memory.episodes" 2>/dev/null || echo "?")
TOTAL_FACTS=$($PSQL -t -A -c "SELECT COUNT(*) FROM memory.facts WHERE superseded_by IS NULL" 2>/dev/null || echo "?")
TOTAL_PROCEDURES=$($PSQL -t -A -c "SELECT COUNT(*) FROM memory.procedures" 2>/dev/null || echo "?")

# Post digest to hub
bash "$NOTIFY" "**Nightly consolidation complete**
- Compressed episodes: $COMPRESSED
- Pruned superseded facts: $PRUNED
- Totals: $TOTAL_EPISODES episodes, $TOTAL_FACTS active facts, $TOTAL_PROCEDURES procedures" "$HUB_CHANNEL" &

exit 0
