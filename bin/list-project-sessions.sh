#!/bin/bash
# Lists all running project sessions (excludes claude-agent hub).

tmux list-sessions 2>/dev/null | grep "^claude-" | grep -v "^claude-agent:" | while read line; do
  SESSION=$(echo "$line" | cut -d: -f1)
  NAME="${SESSION#claude-}"
  # Get the working directory
  DIR=$(tmux display -t "$SESSION" -p '#{pane_current_path}' 2>/dev/null || echo "unknown")
  echo "  $NAME -> $DIR"
done

if ! tmux list-sessions 2>/dev/null | grep -q "^claude-" | grep -v "^claude-agent:"; then
  COUNT=$(tmux list-sessions 2>/dev/null | grep "^claude-" | grep -v "^claude-agent:" | wc -l | tr -d ' ')
  if [ "$COUNT" = "0" ]; then
    echo "  (no project sessions)"
  fi
fi
