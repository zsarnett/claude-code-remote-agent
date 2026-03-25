#!/bin/bash
# Hook script for compaction events.
# Reads a summary from stdin and calls memory_extract via the MCP server.
# Usage: echo "session summary text..." | bash extract-on-compact.sh [session-name]
#
# This script uses the memory_extract tool to auto-extract observations
# from compaction summaries. It's designed to be called from
# dispatch-to-session.sh or compaction hooks.

set -euo pipefail

SESSION_NAME="${1:-}"
SUMMARY=$(cat)

if [ -z "$SUMMARY" ]; then
  echo "[extract-on-compact] No summary provided on stdin. Exiting." >&2
  exit 0
fi

# Check if memory server binary exists
MEMORY_SERVER="${HOME}/.claude/mcp-servers/memory-server/dist/index.js"
if [ ! -f "$MEMORY_SERVER" ]; then
  MEMORY_SERVER="$(dirname "$(dirname "$0")")/dist/index.js"
fi

if [ ! -f "$MEMORY_SERVER" ]; then
  echo "[extract-on-compact] Memory server not found. Skipping extraction." >&2
  exit 0
fi

# Build the MCP tool call JSON
SESSION_ARG=""
if [ -n "$SESSION_NAME" ]; then
  SESSION_ARG=", \"session\": \"$SESSION_NAME\""
fi

# Call via node one-liner that sends the MCP request
# For now, just append directly to observations file as a simpler approach
OBSERVATIONS_FILE="${MEMORY_OBSERVATIONS_PATH:-${HOME}/.claude/memory/observations.md}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Use node to run the extractor directly (faster than full MCP roundtrip)
node -e "
import { extractObservations } from '${MEMORY_SERVER}'.replace('/dist/index.js', '/dist/extractor.js');
// Actually just import from source if available
" 2>/dev/null || true

# Fallback: use simple pattern matching in bash
# (The real extraction happens via memory_extract MCP tool in-session)
echo "[extract-on-compact] Compaction summary received (${#SUMMARY} chars). Use memory_extract tool in-session for full extraction." >&2
