#!/bin/bash
# Hook: Runs when a Claude Code session stops.
# Auto-stores a checkpoint if the session had significant activity.
# Reads session context from stdin (Claude Code passes JSON with session info).
#
# This is meant to be registered as a Stop hook in settings.json alongside
# the existing post-to-discord.sh hook.

set -euo pipefail

# Read stdin (hook receives JSON context from Claude Code)
INPUT=$(cat 2>/dev/null || echo "")

# Extract session info from environment
SESSION_NAME="${CLAUDE_SESSION_NAME:-unknown}"
CHANNEL_ID="${DISCORD_CHANNEL_ID:-}"
CWD="$(pwd)"

# The stop reason from Claude Code
STOP_REASON=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_reason',''))" 2>/dev/null || echo "")

# Extract conversation summary if available
SUMMARY=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('summary',''))" 2>/dev/null || echo "")

# If we have a summary, use memory_extract to capture observations
if [ -n "$SUMMARY" ] && [ ${#SUMMARY} -gt 50 ]; then
  MEMORY_SERVER="${HOME}/.claude/mcp-servers/memory-server/dist/index.js"
  if [ -f "$MEMORY_SERVER" ]; then
    # Use the extractor directly via Node
    node -e "
    import { extractObservations } from '$(dirname "$MEMORY_SERVER")/extractor.js';
    const obs = extractObservations(process.argv[1]);
    if (obs.length > 0) {
      console.error('[memory-on-stop] Extracted ' + obs.length + ' observations from session summary');
    }
    " "$SUMMARY" 2>/dev/null || true
  fi
fi

# Exit cleanly -- don't block session shutdown
exit 0
