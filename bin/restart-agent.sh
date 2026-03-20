#!/bin/bash
# Self-restart script. Kills the current agent session and starts a new one.
# Runs the restart in a detached process so it survives the session dying.

NOTIFY="$HOME/.claude/bin/discord-notify.sh"

bash "$NOTIFY" "Restarting agent session..." 2>/dev/null

# Launch restart in background, detached from the current session
nohup bash -c '
  touch /tmp/claude-agent-restarting.lock
  sleep 2
  tmux kill-session -t claude-agent 2>/dev/null
  sleep 3
  bash ~/.claude/start-agent.sh
  sleep 5
  rm -f /tmp/claude-agent-restarting.lock
  bash ~/.claude/bin/discord-notify.sh "Agent restarted successfully."
' > /dev/null 2>&1 &

disown
