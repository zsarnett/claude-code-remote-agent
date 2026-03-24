#!/bin/bash
# Memory consolidation cron wrapper
# Runs every 30 minutes, skips if sessions are active

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOCK_FILE="/tmp/memory-consolidation.lock"
LOG_FILE="$HOME/.claude/logs/memory-consolidation.log"
IDLE_THRESHOLD=300  # 5 minutes

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Check for active Claude sessions
check_idle() {
  local active=0
  while IFS= read -r line; do
    session_name=$(echo "$line" | awk '{print $1}')
    activity=$(echo "$line" | awk '{print $2}')
    if [[ "$session_name" == claude-* ]]; then
      idle_seconds=$(( $(date +%s) - activity ))
      if [ $idle_seconds -lt $IDLE_THRESHOLD ]; then
        active=1
        break
      fi
    fi
  done < <(tmux list-sessions -F '#{session_name} #{session_activity}' 2>/dev/null)
  echo $active
}

# Check idle
if [ "$(check_idle)" -eq 1 ]; then
  echo "[$(date)] Skipping -- active Claude sessions detected" >> "$LOG_FILE"
  exit 0
fi

# Lock
if [ -f "$LOCK_FILE" ]; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ $lock_age -lt 600 ]; then
    echo "[$(date)] Skipping -- consolidation already running" >> "$LOG_FILE"
    exit 0
  fi
fi
touch "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

# Find the consolidation script
if [ -f "$HOME/.claude/mcp-servers/memory-server/dist/consolidate.js" ]; then
  CONSOLIDATE_SCRIPT="$HOME/.claude/mcp-servers/memory-server/dist/consolidate.js"
elif [ -f "$PROJECT_DIR/dist/consolidate.js" ]; then
  CONSOLIDATE_SCRIPT="$PROJECT_DIR/dist/consolidate.js"
else
  echo "[$(date)] ERROR: consolidate.js not found" >> "$LOG_FILE"
  exit 1
fi

# Run consolidation
echo "[$(date)] Starting consolidation..." >> "$LOG_FILE"
node "$CONSOLIDATE_SCRIPT" 2>&1 >> "$LOG_FILE"
exit_code=$?
echo "[$(date)] Consolidation finished (exit code: $exit_code)" >> "$LOG_FILE"

exit $exit_code
