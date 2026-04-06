#!/bin/bash
# Heartbeat loop -- reads HEARTBEAT.md and has Claude assess each check.
# Runs every 30 minutes via cron. Only posts to Discord if something needs attention.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

HEARTBEAT_FILE="$HOME/Documents/ZacksWorkspace/HEARTBEAT.md"
NOTIFY="$HOME/.claude/bin/discord-notify.sh"
HUB_CHANNEL="1484594218323283989"

if [ ! -f "$HEARTBEAT_FILE" ]; then
  echo "No HEARTBEAT.md found"
  exit 0
fi

# Run Claude headless to assess the heartbeat checklist
RESULT=$(claude -p "Read the file $HEARTBEAT_FILE. For each checklist item, assess whether it needs attention RIGHT NOW by running the appropriate commands.

Rules:
- If EVERYTHING is fine, respond with exactly: HEARTBEAT_OK
- If something needs attention, respond with a SHORT summary (under 500 chars) of only the items that need action. Do not include items that are fine.
- Do not be verbose. No preamble. Just the issues or HEARTBEAT_OK.
- Run real commands to check (git status, df, tmux list-sessions, docker ps, ls SecondBrain/_Inbox/, etc.)" --dangerously-skip-permissions 2>/dev/null)

# Only notify if there's something to report
if [ -n "$RESULT" ] && [ "$RESULT" != "HEARTBEAT_OK" ] && ! echo "$RESULT" | grep -q "^HEARTBEAT_OK$"; then
  bash "$NOTIFY" "[Heartbeat] $RESULT" "$HUB_CHANNEL"
  echo "$(date) - Posted: $RESULT"
else
  echo "$(date) - HEARTBEAT_OK"
fi
