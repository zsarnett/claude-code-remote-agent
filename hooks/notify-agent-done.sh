#!/bin/bash
# Sends a macOS notification only when the user is genuinely needed.
# Fires on: permission_prompt, elicitation_dialog
# Reads Claude Code hook JSON from stdin.

input=$(cat)
event=$(echo "$input" | jq -r '.hook_event_name // "unknown"')
cwd=$(echo "$input" | jq -r '.cwd // "unknown"')
folder=$(basename "$cwd")

case "$event" in
  Notification)
    matcher=$(echo "$input" | jq -r '.notification_type // "unknown"')
    case "$matcher" in
      permission_prompt)
        title="Needs Permission — $folder"
        message="A tool in $folder is waiting for your approval."
        ;;
      elicitation_dialog)
        title="Claude Has a Question — $folder"
        message="Claude in $folder is asking you a question."
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac

osascript -e "display notification \"$message\" with title \"$title\" sound name \"Glass\""
