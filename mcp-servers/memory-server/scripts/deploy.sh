#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$HOME/.claude/mcp-servers/memory-server"
BIN_DIR="$HOME/.claude/bin"

echo "Building..."
cd "$PROJECT_DIR"
npm run build

echo "Deploying to $DEPLOY_DIR..."
mkdir -p "$DEPLOY_DIR/dist"
cp dist/index.js "$DEPLOY_DIR/dist/"
cp dist/consolidate.js "$DEPLOY_DIR/dist/"
cp dist/*.js.map "$DEPLOY_DIR/dist/" 2>/dev/null || true
cp package.json "$DEPLOY_DIR/"

# Copy node_modules (needed for native deps like lancedb)
echo "Syncing node_modules..."
rsync -a --delete node_modules/ "$DEPLOY_DIR/node_modules/"

# Deploy scripts
echo "Installing scripts..."
mkdir -p "$BIN_DIR"
cp scripts/consolidate.sh "$BIN_DIR/memory-consolidate.sh"
chmod +x "$BIN_DIR/memory-consolidate.sh"

# Deploy hooks
mkdir -p "$HOME/.claude/hooks"
cp hooks/session-memory.sh "$HOME/.claude/hooks/session-memory.sh"
chmod +x "$HOME/.claude/hooks/session-memory.sh"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "MCP config to add to settings.json (mcpServers section):"
echo '{'
echo '  "memory": {'
echo '    "command": "node",'
echo "    \"args\": [\"$DEPLOY_DIR/dist/index.js\"],"
echo '    "env": {'
echo "      \"MEMORY_DB_PATH\": \"$HOME/.claude/memory-index\","
echo "      \"MEMORY_VAULT_PATHS\": \"$HOME/.claude/memory,$HOME/Documents/ZacksWorkspace/SecondBrain\","
echo "      \"MEMORY_LOG_PATH\": \"$HOME/.claude/logs/memory-server.log\""
echo '    }'
echo '  }'
echo '}'
echo ""
echo "Cron entry (every 30 min):"
echo "*/30 * * * * /bin/bash $BIN_DIR/memory-consolidate.sh"
echo ""
echo "Add the cron entry with: crontab -e"
