#!/bin/bash
# Start the Claude Workstation Dashboard
# Runs on port 7777

DASHBOARD_DIR="$HOME/.claude/dashboard"

# Install dependencies if needed
if [ ! -d "$DASHBOARD_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  cd "$DASHBOARD_DIR" && npm install --production
fi

# Kill any existing dashboard process on port 7777
lsof -ti:7777 | xargs kill -9 2>/dev/null

echo "Starting Claude Workstation Dashboard..."
cd "$DASHBOARD_DIR" && node server.js &
DASH_PID=$!
echo "Dashboard running at http://localhost:7777 (PID: $DASH_PID)"
echo "$DASH_PID" > "$DASHBOARD_DIR/.pid"
