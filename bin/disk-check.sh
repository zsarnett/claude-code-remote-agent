#!/bin/bash
# Disk usage check. Alerts via Discord if disk usage exceeds threshold.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# Intended for daily cron.

NOTIFY="$HOME/.claude/bin/discord-notify.sh"
THRESHOLD=80  # percent

USAGE=$(df -h / | tail -1 | awk '{print $5}' | tr -d '%')

if (( USAGE >= THRESHOLD )); then
  FREE=$(df -h / | tail -1 | awk '{print $4}')
  bash "$NOTIFY" "**DISK ALERT:** Usage at ${USAGE}% -- ${FREE} free. Time to clean up."
fi
