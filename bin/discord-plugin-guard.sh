#!/bin/bash
# Guard script for the Discord plugin. Only starts the real bot if this is
# the hub session (claude-agent). All other sessions get an immediate exit.
#
# Detection: walk the parent PID chain looking for the agent-loop process
# that has "claude-agent" in its command line.

PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord"

is_hub() {
  local pid=$$
  local depth=0
  while [ "$pid" -gt 1 ] && [ "$depth" -lt 10 ]; do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null)
    if echo "$cmd" | grep -q "claude-agent"; then
      return 0
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    depth=$((depth + 1))
  done
  return 1
}

if is_hub; then
  exec bun run --cwd "$PLUGIN_DIR" --shell=bun --silent start
else
  exit 0
fi
