#!/usr/bin/env bash
set -euo pipefail

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

echo "Uninstalling MCP supergateway services..."

for plist in "$LAUNCH_AGENTS"/com.mcp.*.plist; do
  [ -f "$plist" ] || continue
  name=$(basename "$plist")
  label="${name%.plist}"

  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "  Removed $label"
done

echo "Done. Stdio MCP servers will resume on next Claude Code session start."
