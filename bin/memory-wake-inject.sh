#!/bin/bash
# Retrieve session context from the pgvector memory system.
# Outputs a context block prepended to dispatched messages.
#
# Usage: memory-wake-inject.sh [session-name]
# Returns empty string if Postgres unavailable.

SESSION_NAME="${1:-}"
PSQL="docker exec -i workstation-postgres psql -U workstation -d workstation"

# Check if Postgres is reachable
if ! docker exec workstation-postgres psql -U workstation -d workstation -c "SELECT 1" > /dev/null 2>&1; then
  exit 0
fi

python3 -c "
import subprocess, json, sys

session = '$SESSION_NAME'

def run_sql(sql):
    result = subprocess.run(
        ['docker', 'exec', '-i', 'workstation-postgres', 'psql', '-U', 'workstation', '-d', 'workstation', '-t', '-A', '-F', '|', '-c', sql],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return []
    rows = []
    for line in result.stdout.strip().split('\n'):
        if line.strip():
            rows.append(line)
    return rows

parts = []

# Last episode for this session (handoff equivalent)
if session:
    episodes = run_sql(f\"\"\"
        SELECT summary, outcome,
               EXTRACT(EPOCH FROM (now() - created_at))/3600 AS hours_ago
        FROM memory.episodes
        WHERE session_name LIKE '%{session}%'
        ORDER BY created_at DESC LIMIT 1
    \"\"\")
else:
    episodes = run_sql(\"\"\"
        SELECT summary, outcome,
               EXTRACT(EPOCH FROM (now() - created_at))/3600 AS hours_ago
        FROM memory.episodes
        ORDER BY created_at DESC LIMIT 1
    \"\"\")

if episodes:
    cols = episodes[0].split('|')
    if len(cols) >= 3:
        summary = cols[0]
        hours = round(float(cols[2])) if cols[2] else '?'
        parts.append('[LAST SESSION]')
        parts.append(summary)
        parts.append(f'({hours}h ago)')
        parts.append('')

# Recent active facts (top 10 most recent)
facts = run_sql(\"\"\"
    SELECT content, category FROM memory.facts
    WHERE superseded_by IS NULL
    ORDER BY created_at DESC LIMIT 10
\"\"\")

if facts:
    parts.append(f'[ACTIVE FACTS ({len(facts)})]')
    for row in facts:
        cols = row.split('|')
        if len(cols) >= 2:
            parts.append(f'- [{cols[1]}] {cols[0]}')
    parts.append('')

# Recent procedures (top 3 most used)
procs = run_sql(\"\"\"
    SELECT trigger_desc, steps FROM memory.procedures
    ORDER BY use_count DESC, created_at DESC LIMIT 3
\"\"\")

if procs:
    parts.append(f'[PROCEDURES ({len(procs)})]')
    for row in procs:
        cols = row.split('|')
        if len(cols) >= 2:
            parts.append(f'- When: {cols[0]}')
            parts.append(f'  Do: {cols[1][:200]}')
    parts.append('')

if parts:
    print('--- Session Context (auto-injected from memory) ---')
    print('\n'.join(parts))
    print('--- End Context ---')
" 2>/dev/null
