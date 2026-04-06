#!/bin/bash
# Hook: Runs when a Claude Code session stops.
# Writes an episode record, extracts facts, and posts a summary to Discord.

# NOTE: Do NOT use set -euo pipefail in hooks. A non-zero exit from any
# command causes the hook runner to report "Failed with non-blocking status
# code". Handle errors explicitly with || true instead.

INPUT=$(cat 2>/dev/null || echo "")

SESSION_NAME="${CLAUDE_SESSION_NAME:-unknown}"
CHANNEL_ID="${DISCORD_CHANNEL_ID:-}"
DB_URL="${WORKSTATION_DB_URL:-postgresql://workstation:workstation@localhost:5433/workstation}"
NOTIFY="$HOME/.claude/bin/discord-notify.sh"
PSQL="docker exec -i workstation-postgres psql -U workstation -d workstation"

# Extract fields from Claude Code's JSON context
STOP_REASON=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_reason',''))" 2>/dev/null || echo "")
SUMMARY=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('summary',''))" 2>/dev/null || echo "")
COST=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cost',''))" 2>/dev/null || echo "")
TOKENS=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tokens_used',''))" 2>/dev/null || echo "")

# Skip if no meaningful summary
if [ -z "$SUMMARY" ] || [ ${#SUMMARY} -lt 50 ]; then
  exit 0
fi

# Check if Postgres is reachable
if ! docker exec workstation-postgres psql -U workstation -d workstation -c "SELECT 1" > /dev/null 2>&1; then
  exit 0
fi

# Write episode record
$PSQL -q -c "
  INSERT INTO memory.episodes (session_name, channel_id, summary, outcome, cost, tokens_used)
  VALUES (\$\$${SESSION_NAME}\$\$, \$\$${CHANNEL_ID}\$\$, \$\$${SUMMARY}\$\$, \$\$${STOP_REASON}\$\$,
    $([ -n "$COST" ] && echo "$COST" || echo "NULL"),
    $([ -n "$TOKENS" ] && echo "$TOKENS" || echo "NULL"))
" 2>/dev/null || true

# Auto-update tasks: mark in_progress tasks based on session outcome
if [ "$STOP_REASON" = "user_exit" ] || [ "$STOP_REASON" = "completed" ] || [ "$STOP_REASON" = "stopped" ]; then
  TASK_STATUS="done"
else
  TASK_STATUS="stalled"
fi
$PSQL -q -c "
  UPDATE tasks.items SET status='$TASK_STATUS', updated_at=now()
  WHERE session_name=\$\$${SESSION_NAME}\$\$ AND status='in_progress';
" 2>/dev/null || true

# Extract facts using the memory-mcp extractor via Node
FACTS_COUNT=0
CORRECTIONS_COUNT=0
MEMORY_SERVER="${HOME}/.claude/mcp-servers/memory-server/dist/index.js"
if [ -f "$MEMORY_SERVER" ]; then
  EXTRACTION=$(node -e "
    import { extractObservations } from '$(dirname "$MEMORY_SERVER")/extractor.js';
    const obs = extractObservations(process.argv[1]);
    const facts = obs.filter(o => ['preference','decision','learning','architecture'].includes(o.rule));
    const corrections = obs.filter(o => ['blocker','bug'].includes(o.rule));
    console.log(JSON.stringify({ facts: facts.length, corrections: corrections.length, items: obs }));
  " "$SUMMARY" 2>/dev/null || echo '{"facts":0,"corrections":0,"items":[]}')

  FACTS_COUNT=$(echo "$EXTRACTION" | python3 -c "import sys,json; print(json.load(sys.stdin).get('facts',0))" 2>/dev/null || echo 0)
  CORRECTIONS_COUNT=$(echo "$EXTRACTION" | python3 -c "import sys,json; print(json.load(sys.stdin).get('corrections',0))" 2>/dev/null || echo 0)

  # Insert each extracted item as a fact
  echo "$EXTRACTION" | python3 -c "
import sys, json, subprocess
data = json.load(sys.stdin)
session = '$SESSION_NAME'
for item in data.get('items', []):
    content = item['text'].replace(\"'\", \"''\")
    category = 'correction' if item['rule'] in ('blocker','bug') else 'preference' if item['rule'] == 'preference' else 'domain'
    sql = f\"INSERT INTO memory.facts (content, category, source_session) VALUES ('\$\${content}\$\$', '{category}', '{session}')\"
    subprocess.run(['docker', 'exec', '-i', 'workstation-postgres', 'psql', '-U', 'workstation', '-d', 'workstation', '-q', '-c', sql], capture_output=True)
" 2>/dev/null || true
fi

# Post summary to Discord
if [ -n "$CHANNEL_ID" ]; then
  COST_STR=""
  if [ -n "$COST" ]; then
    COST_STR=" | Cost: ~\$${COST}"
  fi
  bash "$NOTIFY" "Session \`$SESSION_NAME\` ended. Extracted: ${FACTS_COUNT} facts, ${CORRECTIONS_COUNT} corrections${COST_STR}" "$CHANNEL_ID" &
fi

exit 0
