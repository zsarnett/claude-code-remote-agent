#!/bin/bash
# PostCompact hook -- logs context compaction events
# The agent already has memory_search available via MCP and can
# call it explicitly after compaction to recover context.

LOG_FILE="$HOME/.claude/logs/memory-server.log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Context compaction occurred in $(pwd)" >> "$LOG_FILE"
