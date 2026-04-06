#!/usr/bin/env bash
# Compact Claude Code sessions by sending /compact to their tmux pane.
#
# Usage:
#   compact-session.sh <session-name>       -- compact a specific session
#   compact-session.sh --auto [threshold]   -- check ALL sessions, compact idle ones above threshold
#
# Examples:
#   compact-session.sh agent           # compacts claude-agent
#   compact-session.sh myproject       # compacts claude-myproject
#   compact-session.sh --auto          # auto-compact idle sessions above 50%
#   compact-session.sh --auto 30       # auto-compact idle sessions above 30%

set -euo pipefail

DEFAULT_THRESHOLD=50

compact_session() {
  local session="$1"
  if ! tmux has-session -t "$session" 2>/dev/null; then
    echo "Error: tmux session '$session' not found"
    return 1
  fi
  tmux send-keys -t "$session" '/compact' Enter
  echo "Sent /compact to $session"
}

get_context_pct() {
  local session="$1"
  # Capture the pane and look for the context percentage in the status line
  local pane_output
  pane_output=$(tmux capture-pane -t "$session" -p 2>/dev/null || true)
  # Match patterns like "Context: 52% used" or "52%" near "Context"
  local pct
  pct=$(echo "$pane_output" | grep -oE 'Context:?\s*[0-9]+%' | grep -oE '[0-9]+' | tail -1)
  if [ -z "$pct" ]; then
    # Try alternate pattern: look for percentage in the status bar area (last few lines)
    pct=$(echo "$pane_output" | tail -5 | grep -oE '[0-9]+%\s*(context|used)' | grep -oE '[0-9]+' | tail -1)
  fi
  echo "${pct:-0}"
}

is_idle() {
  local session="$1"
  local pane_output
  pane_output=$(tmux capture-pane -t "$session" -p 2>/dev/null || true)
  local last_lines
  last_lines=$(echo "$pane_output" | tail -5)

  # Session is idle if the last lines show a prompt waiting for input
  # (i.e., ends with "> " or "$ " or shows "Waiting for input" or has no active tool calls)
  # Check for active work indicators
  if echo "$last_lines" | grep -qE '(Running|Executing|Writing|Reading|Searching|Compacting|in_progress)'; then
    return 1  # not idle, actively working
  fi

  # Check for the Claude Code input prompt (the ">" prompt at the bottom)
  if echo "$last_lines" | grep -qE '^\s*>\s*$|waiting for|╭|How can I help'; then
    return 0  # idle
  fi

  # If the pane shows a permission prompt, it's waiting but not idle in the compact sense
  if echo "$last_lines" | grep -qiE '(allow|deny|yes/no|approve|permission)'; then
    return 1  # stuck on prompt, not a good time to compact
  fi

  # Default: assume idle if no active work indicators found
  return 0
}

auto_compact() {
  local threshold="${1:-$DEFAULT_THRESHOLD}"
  local compacted=""

  # Get all agent tmux sessions (claude-*, codex-*, gemini-*)
  local sessions
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^(claude|codex|gemini)-' || true)

  if [ -z "$sessions" ]; then
    echo "No agent sessions found."
    return 0
  fi

  for session in $sessions; do
    # Only Claude sessions support /compact -- skip codex/gemini for context compaction
    if [[ "$session" != claude-* ]]; then
      echo "$session: skipped (no compact support for this runtime)"
      continue
    fi

    local pct
    pct=$(get_context_pct "$session")

    if [ "$pct" -gt "$threshold" ]; then
      if is_idle "$session"; then
        echo "$session: context at ${pct}% (threshold: ${threshold}%) -- compacting"
        compact_session "$session"
        compacted="${compacted}${session} (${pct}%), "
      else
        echo "$session: context at ${pct}% but session is active -- skipping"
      fi
    else
      echo "$session: context at ${pct}% -- OK"
    fi
  done

  # Output summary for heartbeat to parse
  if [ -n "$compacted" ]; then
    echo "COMPACTED: ${compacted%, }"
  fi
}

# --- Main ---

case "${1:-}" in
  --auto)
    auto_compact "${2:-$DEFAULT_THRESHOLD}"
    ;;
  "")
    echo "Usage: compact-session.sh <session-name>"
    echo "       compact-session.sh --auto [threshold]"
    exit 1
    ;;
  *)
    # Try claude- prefix first, then codex-, then gemini-
    if tmux has-session -t "claude-$1" 2>/dev/null; then
      compact_session "claude-$1"
    elif tmux has-session -t "codex-$1" 2>/dev/null; then
      echo "Warning: codex sessions do not support /compact"
    elif tmux has-session -t "gemini-$1" 2>/dev/null; then
      echo "Warning: gemini sessions do not support /compact"
    else
      compact_session "claude-$1"  # Let it error with "session not found"
    fi
    ;;
esac
