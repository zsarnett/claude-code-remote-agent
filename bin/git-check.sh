#!/bin/bash
# Checks all git repos in a directory for uncommitted changes or unpushed commits.
# Sends a Discord summary to #hub. Intended for nightly cron.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

NOTIFY="$HOME/.claude/bin/discord-notify.sh"
DOCS_DIR="${1:-$HOME/Documents}"  # Pass a custom directory or default to ~/Documents
ISSUES=""

for dir in "$DOCS_DIR"/*/; do
  if [ -d "$dir/.git" ]; then
    NAME=$(basename "$dir")
    cd "$dir"

    # Check for uncommitted changes
    DIRTY=$(git status --porcelain 2>/dev/null | head -5)
    if [ -n "$DIRTY" ]; then
      COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
      ISSUES="$ISSUES\n- **$NAME**: $COUNT uncommitted changes"
    fi

    # Check for unpushed commits
    UNPUSHED=$(git log --oneline @{upstream}..HEAD 2>/dev/null | head -5)
    if [ -n "$UNPUSHED" ]; then
      COUNT=$(git log --oneline @{upstream}..HEAD 2>/dev/null | wc -l | tr -d ' ')
      ISSUES="$ISSUES\n- **$NAME**: $COUNT unpushed commits"
    fi
  fi
done

if [ -n "$ISSUES" ]; then
  bash "$NOTIFY" "$(echo -e "**Nightly Git Report:**$ISSUES")"
else
  bash "$NOTIFY" "**Nightly Git Report:** All repos clean."
fi
