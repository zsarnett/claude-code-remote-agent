#!/bin/bash
# Stop hook: Clean up orphan Claude subagent and MCP processes
# Runs when a Claude Code session ends
#
# Based on cc-reaper, adapted for this workstation.
# SAFETY: Protects all active claude-* tmux sessions and their process trees.

MCP_WHITELIST="supabase|@stripe/mcp|context7|claude-mem|chroma-mcp|chrome-devtools-mcp|mcp-remote|cloudflare/mcp-server|sequentialthinking|codex.*mcp|supergateway"

# ─── Build protected PID set ─────────────────────────────────────────────────
# Collect pane PIDs and PGIDs from ALL active claude-* tmux sessions.
# These must never be killed -- they are the hub and sibling project sessions.
PROTECTED_PIDS=""
PROTECTED_PGIDS=""
while IFS= read -r session; do
  pane_pid=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null)
  [ -z "$pane_pid" ] && continue
  PROTECTED_PIDS="${PROTECTED_PIDS:+$PROTECTED_PIDS|}$pane_pid"
  pgid=$(ps -o pgid= -p "$pane_pid" 2>/dev/null | tr -d ' ')
  [ -n "$pgid" ] && PROTECTED_PGIDS="${PROTECTED_PGIDS:+$PROTECTED_PGIDS|}$pgid"
done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^claude-')

# Also protect self, parent, grandparent (hook runner chain)
PROTECTED_PIDS="${PROTECTED_PIDS:+$PROTECTED_PIDS|}$$|$PPID"
GRANDPARENT=$(ps -o ppid= -p $PPID 2>/dev/null | tr -d ' ')
[ -n "$GRANDPARENT" ] && PROTECTED_PIDS="$PROTECTED_PIDS|$GRANDPARENT"

# ─── PGID-based cleanup (primary) ────────────────────────────────────────────
# Only clean up processes in THIS session's process group, skip protected PIDs.
SESSION_PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
if [ -n "$SESSION_PGID" ] && [ "$SESSION_PGID" != "0" ] && [ "$SESSION_PGID" != "1" ]; then
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    # Skip if this PID belongs to any active session
    if echo "$pid" | grep -qE "^($PROTECTED_PIDS)$"; then
      continue
    fi
    # Skip if this PID's PGID belongs to another active session
    pid_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$pid_pgid" ] && [ -n "$PROTECTED_PGIDS" ] && echo "$pid_pgid" | grep -qE "^($PROTECTED_PGIDS)$"; then
      # Only kill if it's in OUR pgid, not a sibling session's
      if [ "$pid_pgid" != "$SESSION_PGID" ]; then
        continue
      fi
    fi
    pid_cmd=$(ps -o command= -p "$pid" 2>/dev/null)
    if echo "$pid_cmd" | grep -qE "$MCP_WHITELIST"; then
      continue
    fi
    kill "$pid" 2>/dev/null || true
  done < <(ps -eo pid,pgid 2>/dev/null | awk -v pgid="$SESSION_PGID" \
    '$2 == pgid {print $1}' | grep -vE "^($PROTECTED_PIDS)$")
fi

# ─── Pattern-based fallback ──────────────────────────────────────────────────
# Catches processes that escaped the process group (e.g., called setsid()).
# Only targets detached processes (TTY="??") AND filters out any PID belonging
# to an active claude-* tmux session's process group.
safe_kill() {
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    # Check if this PID's PGID belongs to any active session
    pid_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$pid_pgid" ] && [ -n "$PROTECTED_PGIDS" ] && echo "$pid_pgid" | grep -qE "^($PROTECTED_PGIDS)$"; then
      continue
    fi
    kill "$pid" 2>/dev/null || true
  done
}

ps aux | grep "[c]laude.*stream-json" | awk '$7 == "??" {print $2}' | safe_kill
ps aux | grep -E "[n]pm exec @upstash|[n]pm exec mcp-|[n]px.*mcp-server|[n]ode.*sequential-thinking" | grep -vE "$MCP_WHITELIST" | awk '$7 == "??" {print $2}' | safe_kill
ps aux | grep "[w]orker-service.cjs.*--daemon" | awk '$7 == "??" {print $2}' | safe_kill
ps aux | grep "[b]un.*worker-service" | awk '$7 == "??" {print $2}' | safe_kill

exit 0
