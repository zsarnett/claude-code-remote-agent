#!/bin/bash
# install.sh -- Sets up the Claude Code Remote Agent system
#
# This script copies all scripts, configs, and hooks into ~/.claude/
# and sets up cron jobs and LaunchAgents for auto-start.
#
# Prerequisites:
#   - macOS (for LaunchAgents; Linux users: use systemd instead)
#   - tmux installed (brew install tmux)
#   - jq installed (brew install jq)
#   - Claude Code CLI installed (npm install -g @anthropic-ai/claude-code)
#   - Node.js installed (for dashboard)
#   - A Discord bot token (see README.md for setup)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
BIN_DIR="$CLAUDE_DIR/bin"
HOOKS_DIR="$CLAUDE_DIR/hooks"
DASHBOARD_DIR="$CLAUDE_DIR/dashboard"
CHANNELS_DIR="$CLAUDE_DIR/channels"
LOGS_DIR="$CLAUDE_DIR/logs"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

echo "=== Claude Code Remote Agent Installer ==="
echo ""

# Check prerequisites
for cmd in tmux jq claude node npm; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "ERROR: '$cmd' is not installed. Please install it first."
    exit 1
  fi
done

echo "All prerequisites found."
echo ""

# Create directories
echo "Creating directories..."
mkdir -p "$BIN_DIR" "$HOOKS_DIR" "$DASHBOARD_DIR" "$LOGS_DIR"
mkdir -p "$CHANNELS_DIR/discord" "$CHANNELS_DIR/slack" "$CHANNELS_DIR/zoom"
mkdir -p "$CLAUDE_DIR/timers"

# Copy scripts
echo "Copying scripts..."
cp "$SCRIPT_DIR/start-agent.sh" "$CLAUDE_DIR/start-agent.sh"
cp "$SCRIPT_DIR/bin/"*.sh "$BIN_DIR/"
cp "$SCRIPT_DIR/bin/"*.md "$BIN_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR/project-agent-instructions.md" "$CLAUDE_DIR/project-agent-instructions.md"

# Copy agent definitions
echo "Copying agent definitions..."
mkdir -p "$CLAUDE_DIR/agents"
cp "$SCRIPT_DIR/agents/"*.md "$CLAUDE_DIR/agents/" 2>/dev/null || true

# Copy hooks
echo "Copying hooks..."
cp "$SCRIPT_DIR/hooks/"*.sh "$HOOKS_DIR/"

# Copy dashboard
echo "Copying dashboard..."
cp "$SCRIPT_DIR/dashboard/server.js" "$DASHBOARD_DIR/server.js"
cp "$SCRIPT_DIR/dashboard/package.json" "$DASHBOARD_DIR/package.json"

# Install dashboard dependencies
echo "Installing dashboard dependencies..."
cd "$DASHBOARD_DIR" && npm install --production --silent
cd "$SCRIPT_DIR"

# Build and install Memory MCP server
MEMORY_SRC="$SCRIPT_DIR/mcp-servers/memory-server"
MEMORY_DEST="$CLAUDE_DIR/mcp-servers/memory-server"
if [ -d "$MEMORY_SRC" ]; then
  echo ""
  echo "Building Memory MCP server..."
  mkdir -p "$MEMORY_DEST/dist"
  cd "$MEMORY_SRC"
  npm install --silent
  npm run build --silent 2>/dev/null || npm run build
  cp -r dist/ "$MEMORY_DEST/dist/"
  cp package.json "$MEMORY_DEST/"
  rsync -a --quiet node_modules/ "$MEMORY_DEST/node_modules/" 2>/dev/null || cp -r node_modules/ "$MEMORY_DEST/node_modules/"
  cp scripts/consolidate.sh "$BIN_DIR/memory-consolidate.sh"
  chmod +x "$BIN_DIR/memory-consolidate.sh"
  cp hooks/session-memory.sh "$HOOKS_DIR/session-memory.sh"
  chmod +x "$HOOKS_DIR/session-memory.sh"
  mkdir -p "$CLAUDE_DIR/memory-index"
  cd "$SCRIPT_DIR"
  echo "  Memory MCP server installed at $MEMORY_DEST"
  echo "  Vector index directory: $CLAUDE_DIR/memory-index"
else
  echo "  Memory MCP server source not found, skipping..."
fi

# Make all scripts executable
echo "Setting permissions..."
chmod +x "$CLAUDE_DIR/start-agent.sh"
chmod +x "$BIN_DIR/"*.sh
chmod +x "$HOOKS_DIR/"*.sh

# Copy example configs if real configs don't exist
if [ ! -f "$CHANNELS_DIR/discord/.env" ]; then
  cp "$SCRIPT_DIR/channels/discord/.env.example" "$CHANNELS_DIR/discord/.env"
  echo ""
  echo "** IMPORTANT: Edit $CHANNELS_DIR/discord/.env with your Discord bot token **"
fi

if [ ! -f "$CHANNELS_DIR/discord/channel-map.json" ]; then
  cp "$SCRIPT_DIR/channels/discord/channel-map.example.json" "$CHANNELS_DIR/discord/channel-map.json"
  echo "** IMPORTANT: Edit $CHANNELS_DIR/discord/channel-map.json with your guild/channel IDs **"
fi

if [ ! -f "$CHANNELS_DIR/discord/access.json" ]; then
  cp "$SCRIPT_DIR/channels/discord/access.example.json" "$CHANNELS_DIR/discord/access.json"
  echo "** IMPORTANT: Edit $CHANNELS_DIR/discord/access.json with your Discord user ID **"
fi

if [ ! -f "$CHANNELS_DIR/slack/config.json" ]; then
  cp "$SCRIPT_DIR/channels/slack/config.example.json" "$CHANNELS_DIR/slack/config.json"
  echo "** Edit $CHANNELS_DIR/slack/config.json if you want Slack bridge support **"
fi

if [ ! -f "$CHANNELS_DIR/zoom/config.json" ]; then
  cp "$SCRIPT_DIR/channels/zoom/config.example.json" "$CHANNELS_DIR/zoom/config.json"
  echo "** Edit $CHANNELS_DIR/zoom/config.json if you want Zoom transcript integration **"
fi

# Copy HEARTBEAT.md template if not present
WORKSPACE_DIR="${CLAUDE_AGENT_WORKSPACE:-$HOME/Documents}"
if [ ! -f "$WORKSPACE_DIR/HEARTBEAT.md" ] && [ ! -f "$HOME/HEARTBEAT.md" ]; then
  cp "$SCRIPT_DIR/examples/HEARTBEAT.md.example" "$HOME/HEARTBEAT.md"
  echo "** Copied HEARTBEAT.md template to $HOME/HEARTBEAT.md -- customize your checks **"
fi

# Set up LaunchAgent (macOS only)
if [ -d "$LAUNCH_DIR" ]; then
  echo ""
  echo "Setting up LaunchAgent for auto-start on login..."
  PLIST="$LAUNCH_DIR/com.claude.agent.plist"
  sed "s|__HOME__|$HOME|g" "$SCRIPT_DIR/launchd/com.claude.agent.plist" > "$PLIST"
  echo "LaunchAgent installed at $PLIST"
  echo "  To enable: launchctl load $PLIST"
  echo "  To disable: launchctl unload $PLIST"
fi

# Set up cron jobs
echo ""
echo "Setting up cron jobs..."
EXISTING_CRON=$(crontab -l 2>/dev/null || true)
NEW_CRON="$EXISTING_CRON"

add_cron() {
  local SCHEDULE="$1"
  local CMD="$2"
  local COMMENT="$3"
  if ! echo "$EXISTING_CRON" | grep -qF "$CMD"; then
    NEW_CRON="$NEW_CRON
# $COMMENT
$SCHEDULE $CMD"
    echo "  Added: $COMMENT"
  else
    echo "  Already exists: $COMMENT"
  fi
}

add_cron "*/5 * * * *" "bash ~/.claude/bin/health-check.sh >> ~/.claude/logs/health-check.log 2>&1" "Claude Agent - Health check every 5 minutes"
add_cron "0 21 * * *" "bash ~/.claude/bin/git-check.sh >> ~/.claude/logs/git-check.log 2>&1" "Claude Agent - Nightly git repo check at 9pm"
add_cron "0 8 * * *" "bash ~/.claude/bin/disk-check.sh >> ~/.claude/logs/disk-check.log 2>&1" "Claude Agent - Daily disk usage check at 8am"
add_cron "*/30 * * * *" "bash ~/.claude/bin/heartbeat.sh >> ~/.claude/logs/heartbeat.log 2>&1" "Claude Agent - Heartbeat every 30 minutes"
add_cron "0 8 * * 1-5" "bash ~/.claude/bin/morning-briefing.sh >> ~/.claude/logs/morning-briefing.log 2>&1" "Claude Agent - Morning briefing weekdays at 8am"
add_cron "*/30 * * * *" "/bin/bash ~/.claude/bin/memory-consolidate.sh >> ~/.claude/logs/memory-consolidation.log 2>&1" "Memory MCP - Consolidation every 30 minutes"

echo "$NEW_CRON" | crontab -

# Print shell aliases
echo ""
echo "=== Add these aliases to your ~/.zshrc or ~/.bashrc ==="
echo ""
echo 'claude-agent() { bash ~/.claude/start-agent.sh "$@"; }'
echo 'claude-agents() { bash ~/.claude/start-agent.sh list; }'
echo 'claude-attach() { tmux attach -t "claude-${1:-agent}"; }'
echo 'claude-stop() { bash ~/.claude/start-agent.sh stop "$@"; }'
echo ""

echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Add the shell aliases above to your shell rc file"
echo "  2. Edit ~/.claude/channels/discord/.env with your bot token"
echo "  3. Edit ~/.claude/channels/discord/channel-map.json with your guild/channel IDs"
echo "  4. Edit ~/.claude/channels/discord/access.json with your Discord user ID"
echo "  5. Update discord-create-channel.sh with your bot user ID and Discord user ID"
echo "  6. Update discord-notify.sh with your hub channel ID"
echo "  7. (Optional) Edit ~/.claude/channels/zoom/config.json for Zoom transcripts"
echo "  8. (Optional) Set up Outlook MCP -- see bin/outlook-setup-instructions.md"
echo "  9. (Optional) Customize ~/HEARTBEAT.md with your monitoring checks"
echo " 10. (Optional) Add Memory MCP to your workspace .mcp.json -- see mcp-servers/memory-server/README.md"
echo " 11. Run: claude-agent  (to start the hub session)"
echo " 12. Open http://localhost:7777 to see the dashboard"
echo ""
echo "See README.md for full setup guide."
