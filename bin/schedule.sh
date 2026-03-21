#!/bin/bash
# Schedule a message to be sent to Discord (or back to the agent) after a delay.
# Supports one-shot timers and recurring cron jobs.
#
# Usage:
#   schedule.sh timer <delay> <channel-id> <message>      -- one-shot after delay (e.g. "30m", "2h", "45s")
#   schedule.sh cron <schedule> <channel-id> <message>     -- recurring cron (e.g. "*/30 * * * *")
#   schedule.sh list                                        -- list scheduled timers and crons
#   schedule.sh cancel <id>                                 -- cancel a timer by PID or remove a cron line

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ACTION="$1"
NOTIFY="$HOME/.claude/bin/discord-notify.sh"
TIMER_DIR="$HOME/.claude/timers"
mkdir -p "$TIMER_DIR"

parse_delay() {
  local input="$1"
  local num="${input%[smhd]}"
  local unit="${input: -1}"
  case "$unit" in
    s) echo "$num" ;;
    m) echo $((num * 60)) ;;
    h) echo $((num * 3600)) ;;
    d) echo $((num * 86400)) ;;
    *) echo "$((input))" ;;  # assume seconds if no unit
  esac
}

case "$ACTION" in
  timer)
    DELAY="$2"
    CHANNEL_ID="$3"
    MESSAGE="$4"

    if [ -z "$DELAY" ] || [ -z "$CHANNEL_ID" ] || [ -z "$MESSAGE" ]; then
      echo "Usage: schedule.sh timer <delay> <channel-id> <message>"
      exit 1
    fi

    SECONDS_DELAY=$(parse_delay "$DELAY")
    FIRE_AT=$(date -v+"${SECONDS_DELAY}S" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || date -d "+${SECONDS_DELAY} seconds" "+%Y-%m-%d %H:%M:%S" 2>/dev/null)

    # Run in background
    (
      sleep "$SECONDS_DELAY"
      bash "$NOTIFY" "$MESSAGE" "$CHANNEL_ID"
      rm -f "$TIMER_DIR/$$.timer" 2>/dev/null
    ) &

    TIMER_PID=$!
    echo "{\"pid\": $TIMER_PID, \"delay\": \"$DELAY\", \"fire_at\": \"$FIRE_AT\", \"channel\": \"$CHANNEL_ID\", \"message\": \"$MESSAGE\"}" > "$TIMER_DIR/$TIMER_PID.timer"

    echo "Timer set: $MESSAGE in $DELAY (fires at $FIRE_AT, PID $TIMER_PID)"
    ;;

  cron)
    SCHEDULE="$2"
    CHANNEL_ID="$3"
    MESSAGE="$4"

    if [ -z "$SCHEDULE" ] || [ -z "$CHANNEL_ID" ] || [ -z "$MESSAGE" ]; then
      echo "Usage: schedule.sh cron <schedule> <channel-id> <message>"
      exit 1
    fi

    # Add to crontab
    CRON_LINE="$SCHEDULE /bin/bash $NOTIFY \"$MESSAGE\" \"$CHANNEL_ID\""
    (crontab -l 2>/dev/null; echo "# claude-scheduled: $MESSAGE"; echo "$CRON_LINE") | crontab -

    echo "Cron added: $SCHEDULE -> $MESSAGE"
    ;;

  list)
    echo "=== Active Timers ==="
    shopt -s nullglob 2>/dev/null
    for f in "$TIMER_DIR"/*.timer; do
      if [ -f "$f" ]; then
        PID=$(basename "$f" .timer)
        if kill -0 "$PID" 2>/dev/null; then
          cat "$f"
        else
          rm -f "$f"
        fi
      fi
    done

    echo ""
    echo "=== Scheduled Crons ==="
    crontab -l 2>/dev/null | grep "claude-scheduled" -A1 | grep -v "^--$"
    ;;

  cancel)
    TARGET="$2"
    if [ -z "$TARGET" ]; then
      echo "Usage: schedule.sh cancel <pid>"
      exit 1
    fi

    # Try to kill timer
    if [ -f "$TIMER_DIR/$TARGET.timer" ]; then
      kill "$TARGET" 2>/dev/null
      rm -f "$TIMER_DIR/$TARGET.timer"
      echo "Timer $TARGET cancelled"
    else
      # Try to remove from crontab by line content
      crontab -l 2>/dev/null | grep -v "$TARGET" | crontab -
      echo "Removed cron matching: $TARGET"
    fi
    ;;

  *)
    echo "Usage: schedule.sh <timer|cron|list|cancel> [args...]"
    echo ""
    echo "Examples:"
    echo "  schedule.sh timer 30m YOUR_CHANNEL_ID 'Reminder: check deploy status'"
    echo "  schedule.sh timer 2h YOUR_CHANNEL_ID 'Time to review PRs'"
    echo "  schedule.sh cron '0 9 * * *' YOUR_CHANNEL_ID 'Good morning! Check email and Slack.'"
    echo "  schedule.sh list"
    echo "  schedule.sh cancel 12345"
    ;;
esac
