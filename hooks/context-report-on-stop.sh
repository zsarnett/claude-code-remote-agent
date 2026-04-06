#!/bin/bash
# Stop hook: posts this session's context % to its own Discord channel.
# Scrapes the context line from the tmux pane buffer before claude exits.

NOTIFY="$HOME/.claude/bin/discord-notify.sh"
DEBUG_LOG="$HOME/.claude/logs/context-report-debug.log"

# Drain stdin so we don't block (prior hooks may have consumed it already)
cat > /dev/null 2>&1 &

# Get channel ID from env or tmux session environment
CHANNEL_ID="${DISCORD_CHANNEL_ID}"
if [ -z "$CHANNEL_ID" ] && [ -n "$TMUX_PANE" ]; then
  SESSION=$(tmux list-panes -a -F '#{pane_id}|#{session_name}' 2>/dev/null | grep "^${TMUX_PANE}|" | cut -d'|' -f2)
  if [ -n "$SESSION" ]; then
    CHANNEL_ID=$(tmux show-environment -t "$SESSION" DISCORD_CHANNEL_ID 2>/dev/null | cut -d= -f2-)
  fi
fi

echo "$(date) CHANNEL_ID=${CHANNEL_ID:-EMPTY} TMUX_PANE=${TMUX_PANE:-EMPTY}" >> "$DEBUG_LOG"

if [ -z "$CHANNEL_ID" ]; then
  exit 0
fi

# Capture context line from the tmux pane buffer.
# The status line looks like: "  Context: 70.0% | Tokens: 2,477,728 | Opus 4.6 | ..."
CONTEXT_LINE=""
if [ -n "$TMUX_PANE" ]; then
  # Search last 200 lines -- the context line may be above the current viewport
  CONTEXT_LINE=$(tmux capture-pane -t "$TMUX_PANE" -p -S -200 2>/dev/null | grep -E 'Context: [0-9]' | tail -1)
fi

echo "$(date) CONTEXT_LINE=${CONTEXT_LINE:-EMPTY}" >> "$DEBUG_LOG"

if [ -n "$CONTEXT_LINE" ]; then
  PCT=$(echo "$CONTEXT_LINE" | grep -oE '[0-9]+\.[0-9]+%' | head -1)
  TOKENS=$(echo "$CONTEXT_LINE" | grep -oE 'Tokens: [0-9,]+' | head -1 | sed 's/Tokens: //')
  MODEL=$(echo "$CONTEXT_LINE" | grep -oE '(Opus|Sonnet|Haiku) [0-9.]+' | head -1)
  MSG="Session stopped | Context: ${PCT:-?} | Tokens: ${TOKENS:-?} | ${MODEL:-?}"
  bash "$NOTIFY" "$MSG" "$CHANNEL_ID"
else
  # Fallback: still post but indicate we couldn't get context
  bash "$NOTIFY" "Session stopped (context % unavailable)" "$CHANNEL_ID"
fi

# Swap brain reaction to checkmark on clean exit
MESSAGE_ID="${DISCORD_MESSAGE_ID}"
if [ -z "$MESSAGE_ID" ] && [ -n "$TMUX_PANE" ]; then
  SESSION=$(tmux list-panes -a -F '#{pane_id}|#{session_name}' 2>/dev/null | grep "^${TMUX_PANE}|" | cut -d'|' -f2)
  if [ -n "$SESSION" ]; then
    MESSAGE_ID=$(tmux show-environment -t "$SESSION" DISCORD_MESSAGE_ID 2>/dev/null | cut -d= -f2-)
  fi
fi

REACT="$HOME/.claude/bin/discord-react.sh"
if [ -n "$MESSAGE_ID" ] && [ -n "$CHANNEL_ID" ]; then
  bash "$REACT" remove "$CHANNEL_ID" "$MESSAGE_ID" brain &
  bash "$REACT" add "$CHANNEL_ID" "$MESSAGE_ID" white_check_mark &
fi

# Log session run to audit
SESSION_NAME=""
if [ -n "$TMUX_PANE" ]; then
  SESSION_NAME=$(tmux list-panes -a -F '#{pane_id}|#{session_name}' 2>/dev/null | grep "^${TMUX_PANE}|" | cut -d'|' -f2)
fi
if [ -n "$SESSION_NAME" ]; then
  RUNTIME="claude"
  case "$SESSION_NAME" in codex-*) RUNTIME="codex" ;; gemini-*) RUNTIME="gemini" ;; esac
  bash "$HOME/.claude/bin/audit-log.sh" session_runs \
    session_name="$SESSION_NAME" runtime="$RUNTIME" stop_reason=completed \
    context_percent="${PCT:-0}" tokens_used="${TOKENS:-0}" model="${MODEL:-unknown}" &
fi

exit 0
