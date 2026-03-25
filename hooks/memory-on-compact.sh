#!/bin/bash
# Hook: Runs after context compaction in Claude Code.
# Extracts observations from the compaction summary and stores them.
# Reads the compaction summary from stdin (Claude Code passes JSON).
#
# Register as a PostCompact hook in settings.json.

set -euo pipefail

# Read stdin
INPUT=$(cat 2>/dev/null || echo "")

# Extract the summary text from compaction output
SUMMARY=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('summary', d.get('text', '')))
except:
    print(sys.stdin.read() if hasattr(sys.stdin, 'read') else '')
" 2>/dev/null || echo "$INPUT")

if [ -z "$SUMMARY" ] || [ ${#SUMMARY} -lt 30 ]; then
  exit 0
fi

SESSION_NAME="${CLAUDE_SESSION_NAME:-}"
MEMORY_SERVER="${HOME}/.claude/mcp-servers/memory-server/dist/index.js"

if [ ! -f "$MEMORY_SERVER" ]; then
  exit 0
fi

# Extract observations from the compaction summary
# Uses the extractor module directly -- no MCP roundtrip needed
node -e "
import { extractObservations } from '$(dirname "$MEMORY_SERVER")/extractor.js';
import { appendObservation } from '$(dirname "$MEMORY_SERVER")/observations.js';

const summary = process.argv[1];
const session = process.argv[2] || '';

const observations = extractObservations(summary);
const timestamp = new Date().toISOString().replace(/\.\d{3}Z\$/, 'Z');

let stored = 0;
for (const obs of observations) {
  await appendObservation({
    timestamp,
    priority: obs.priority,
    text: obs.text,
    session: session || undefined,
  });
  stored++;
}

if (stored > 0) {
  process.stderr.write('[memory-on-compact] Extracted and stored ' + stored + ' observations from compaction summary\n');
}
" "$SUMMARY" "$SESSION_NAME" 2>/dev/null || true

exit 0
