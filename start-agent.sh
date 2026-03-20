#!/bin/bash
# Starts Claude Code in a persistent tmux session with Discord channel
#
# Usage:
#   claude-agent                          # default session in workspace
#   claude-agent myproject                # named session in workspace/myproject or ~/Documents/myproject
#   claude-agent myproject /path/to/dir   # named session in specific directory
#   claude-agents                         # list all running claude sessions
#   claude-stop myproject                 # kill a specific session
#   claude-stop --all                     # kill all claude sessions

ACTION="${1:-start}"
WORKSPACE_DIR="${CLAUDE_AGENT_WORKSPACE:-$HOME/Documents}"

# List all sessions
if [ "$ACTION" = "list" ]; then
  echo "Running Claude Code sessions:"
  tmux list-sessions 2>/dev/null | grep "^claude-" || echo "  (none)"
  exit 0
fi

# Stop session(s)
if [ "$ACTION" = "stop" ]; then
  TARGET="${2:---all}"
  if [ "$TARGET" = "--all" ]; then
    tmux list-sessions 2>/dev/null | grep "^claude-" | cut -d: -f1 | while read s; do
      tmux kill-session -t "$s"
      echo "Killed $s"
    done
  else
    tmux kill-session -t "claude-$TARGET" 2>/dev/null && echo "Killed claude-$TARGET" || echo "No session claude-$TARGET"
  fi
  exit 0
fi

# Start a session
NAME="${1:-agent}"
SESSION="claude-$NAME"
DIR="${2:-}"

# Resolve working directory
if [ -z "$DIR" ]; then
  if [ "$NAME" = "agent" ]; then
    DIR="$WORKSPACE_DIR"
  elif [ -d "$WORKSPACE_DIR/$NAME" ]; then
    DIR="$WORKSPACE_DIR/$NAME"
  else
    echo "Directory not found for '$NAME'. Pass an explicit path:"
    echo "  claude-agent $NAME /path/to/dir"
    exit 1
  fi
fi

if [ ! -d "$DIR" ]; then
  echo "Directory does not exist: $DIR"
  exit 1
fi

# Check if session already exists
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' is already running in $(tmux display -t "$SESSION" -p '#{pane_current_path}' 2>/dev/null || echo 'unknown dir')"
  echo "  Attach:  tmux attach -t $SESSION"
  echo "  Kill:    tmux kill-session -t $SESSION"
  exit 0
fi

# Start new detached tmux session with auto-restart wrapper
tmux new-session -d -s "$SESSION" -c "$DIR" \
  "bash ~/.claude/bin/agent-loop.sh '$SESSION' '$DIR'"

# Start dashboard if this is the main agent session
if [ "$NAME" = "agent" ]; then
  bash ~/.claude/bin/start-dashboard.sh 2>/dev/null
fi

echo "Started '$SESSION' in $DIR (auto-restart enabled)"
echo "  Attach:  tmux attach -t $SESSION"
echo "  Detach:  Ctrl+B then D"
