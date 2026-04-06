#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/.mcp-services/logs"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

echo "Installing MCP supergateway services..."

# Create log directory
mkdir -p "$LOG_DIR"

# Pre-cache supergateway so launchd doesn't race on first boot
echo "Pre-caching supergateway..."
npx -y supergateway --version 2>/dev/null || true

# Install each plist
for plist in "$SCRIPT_DIR"/com.mcp.*.plist; do
  name=$(basename "$plist")
  label="${name%.plist}"

  # Unload if already loaded
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true

  # Copy to LaunchAgents
  cp "$plist" "$LAUNCH_AGENTS/$name"

  # Load
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/$name"
  echo "  Loaded $label"
done

echo ""
echo "All MCP services installed. Checking health..."
sleep 3

for port in 8001 8002 8003 8004 8005 8006 8007; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/healthz" 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then
    echo "  Port $port: OK"
  else
    echo "  Port $port: NOT READY (status=$status) -- check $LOG_DIR/"
  fi
done

echo ""
echo "Done. Run 'uninstall-mcp-services.sh' to reverse."
