#!/bin/bash
# Dispatches a Discord message to a dedicated project tmux session.
# All sessions are persistent interactive processes. Messages are pasted
# into the running agent via tmux load-buffer + paste-buffer.
#
# Usage: dispatch-to-session.sh <session-name> <project-dir> <discord-channel-id> <message> [agent-name] [runtime] [message-id]
# agent-name is optional -- if provided, starts claude with --agent <agent-name> (first message only)
# runtime is optional -- "claude" (default), "codex", or "gemini"

NAME="$1"
PROJECT_DIR="$2"
CHANNEL_ID="$3"
MESSAGE="$4"
AGENT="$5"
RUNTIME="${6:-claude}"
MESSAGE_ID="${7:-}"

if [ -z "$NAME" ] || [ -z "$PROJECT_DIR" ] || [ -z "$CHANNEL_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: dispatch-to-session.sh <name> <dir> <channel-id> <message> [agent-name] [runtime] [message-id]"
  exit 1
fi

if [ "$RUNTIME" != "claude" ] && [ "$RUNTIME" != "codex" ] && [ "$RUNTIME" != "gemini" ]; then
  echo "Error: runtime must be 'claude', 'codex', or 'gemini', got '$RUNTIME'"
  exit 1
fi

# Session prefix matches runtime
SESSION_NAME="${RUNTIME}-${NAME}"

# Auto-inject last checkpoint/handoff context from memory system
WAKE_SCRIPT="$HOME/.claude/bin/memory-wake-inject.sh"
CONTEXT=""
if [ -x "$WAKE_SCRIPT" ]; then
  CONTEXT=$("$WAKE_SCRIPT" "$NAME" 2>/dev/null)
fi

# Build the full message with optional context injection
FULL_MESSAGE="$MESSAGE"
if [ -n "$CONTEXT" ]; then
  FULL_MESSAGE="$CONTEXT

$MESSAGE"
fi

# Flatten message to single line for tmux paste safety
MSG_FILE=$(mktemp /tmp/dispatch-msg-XXXXXX)
FLAT_MESSAGE=$(echo "$FULL_MESSAGE" | tr '\n' ' ' | sed 's/  */ /g')

# --- Inject Discord instructions for the runtime ---
DISCORD_INSTRUCTIONS="$HOME/Documents/ZacksWorkspace/agent-scripts/discord-session-instructions.md"
QUALITY_RULES="$HOME/Documents/ZacksWorkspace/agent-scripts/quality-rules.md"
if [ "$RUNTIME" = "claude" ]; then
  mkdir -p "$PROJECT_DIR/.claude/rules"
  if [ -f "$DISCORD_INSTRUCTIONS" ]; then
    cp "$DISCORD_INSTRUCTIONS" "$PROJECT_DIR/.claude/rules/discord.md"
  fi
  if [ -f "$QUALITY_RULES" ]; then
    cp "$QUALITY_RULES" "$PROJECT_DIR/.claude/rules/quality.md"
  fi
elif [ "$RUNTIME" = "codex" ]; then
  # Codex reads AGENTS.md for project instructions (configured via project_doc_fallback_filenames)
  CODEX_INSTRUCTIONS="$HOME/Documents/ZacksWorkspace/agent-scripts/codex-session-instructions.md"
  if [ -f "$CODEX_INSTRUCTIONS" ]; then
    if [ -f "$PROJECT_DIR/AGENTS.md" ]; then
      if ! grep -q "Discord Communication" "$PROJECT_DIR/AGENTS.md" 2>/dev/null; then
        echo "" >> "$PROJECT_DIR/AGENTS.md"
        cat "$CODEX_INSTRUCTIONS" >> "$PROJECT_DIR/AGENTS.md"
      fi
    else
      cp "$CODEX_INSTRUCTIONS" "$PROJECT_DIR/AGENTS.md"
    fi
  fi
  # Inject quality rules into AGENTS.md for Codex
  if [ -f "$QUALITY_RULES" ]; then
    if [ -f "$PROJECT_DIR/AGENTS.md" ] && ! grep -q "Quality Rules" "$PROJECT_DIR/AGENTS.md" 2>/dev/null; then
      echo "" >> "$PROJECT_DIR/AGENTS.md"
      cat "$QUALITY_RULES" >> "$PROJECT_DIR/AGENTS.md"
    fi
  fi
elif [ "$RUNTIME" = "gemini" ]; then
  # Gemini reads GEMINI.md for project instructions
  GEMINI_INSTRUCTIONS="$HOME/Documents/ZacksWorkspace/agent-scripts/gemini-session-instructions.md"
  if [ -f "$GEMINI_INSTRUCTIONS" ]; then
    if [ -f "$PROJECT_DIR/GEMINI.md" ]; then
      if ! grep -q "Discord Communication" "$PROJECT_DIR/GEMINI.md" 2>/dev/null; then
        echo "" >> "$PROJECT_DIR/GEMINI.md"
        cat "$GEMINI_INSTRUCTIONS" >> "$PROJECT_DIR/GEMINI.md"
      fi
    else
      cp "$GEMINI_INSTRUCTIONS" "$PROJECT_DIR/GEMINI.md"
    fi
  fi
  # Inject quality rules into GEMINI.md
  if [ -f "$QUALITY_RULES" ]; then
    if [ -f "$PROJECT_DIR/GEMINI.md" ] && ! grep -q "Quality Rules" "$PROJECT_DIR/GEMINI.md" 2>/dev/null; then
      echo "" >> "$PROJECT_DIR/GEMINI.md"
      cat "$QUALITY_RULES" >> "$PROJECT_DIR/GEMINI.md"
    fi
  fi
fi

# --- Read per-project session config (model, etc.) ---
PROJECT_MODEL=""
SESSION_CONFIG="$PROJECT_DIR/.claude/session-config.json"
if [ -f "$SESSION_CONFIG" ] && command -v python3 >/dev/null 2>&1; then
  PROJECT_MODEL=$(python3 -c "import json,sys; c=json.load(open('$SESSION_CONFIG')); print(c.get('model',''))" 2>/dev/null)
fi

# --- Build the agent command based on runtime ---
build_agent_cmd() {
  case "$RUNTIME" in
    claude)
      local cmd="claude --dangerously-skip-permissions"
      if [ -n "$AGENT" ]; then
        cmd="claude --agent $AGENT --dangerously-skip-permissions"
      fi
      if [ -n "$PROJECT_MODEL" ]; then
        cmd="$cmd --model $PROJECT_MODEL"
      fi
      echo "$cmd"
      ;;
    codex)
      # Use --dangerously-bypass-approvals-and-sandbox so codex can run
      # discord-notify.sh and other shell commands without prompting.
      # --full-auto only allows workspace-write sandbox which blocks Discord posts.
      echo "/opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox -C $PROJECT_DIR"
      ;;
    gemini)
      echo "gemini --yolo"
      ;;
  esac
}

AGENT_CMD=$(build_agent_cmd)

# --- Detect if the agent process is already running in the session ---
is_agent_running() {
  local session="$1"
  if ! tmux has-session -t "$session" 2>/dev/null; then
    return 1
  fi
  local pane_pid
  pane_pid=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null | head -1)
  if [ -z "$pane_pid" ]; then
    return 1
  fi
  # Check for the runtime binary running as a child of the pane
  case "$RUNTIME" in
    claude) pgrep -P "$pane_pid" -f "claude" >/dev/null 2>&1 ;;
    codex)  pgrep -P "$pane_pid" -f "codex" >/dev/null 2>&1 ;;
    gemini) pgrep -P "$pane_pid" -f "gemini" >/dev/null 2>&1 ;;
  esac
}

# --- Dispatch: paste message into running or new session ---

if is_agent_running "$SESSION_NAME"; then
  # Agent is already running -- paste the message directly into it.
  echo "$FLAT_MESSAGE" > "$MSG_FILE"
  tmux load-buffer "$MSG_FILE"
  tmux paste-buffer -t "$SESSION_NAME"
  sleep 1
  tmux send-keys -t "$SESSION_NAME" Enter
  sleep 0.3
  tmux send-keys -t "$SESSION_NAME" Enter
  rm -f "$MSG_FILE"
  if [ -n "$MESSAGE_ID" ]; then
    bash "$HOME/.claude/bin/discord-react.sh" add "$CHANNEL_ID" "$MESSAGE_ID" eyes &
  fi
  bash "$HOME/.claude/bin/audit-log.sh" dispatches \
    session_name="$SESSION_NAME" runtime="$RUNTIME" channel_id="$CHANNEL_ID" \
    message_preview="$(echo "$MESSAGE" | head -c 200)" &
  # Auto-create task from dispatch
  TASK_TITLE=$(echo "$MESSAGE" | head -c 100 | tr '\n' ' ')
  bash "$HOME/.claude/bin/task-create.sh" "$TASK_TITLE" \
    --session "$SESSION_NAME" --channel "$CHANNEL_ID" --status pending &
  echo "Dispatched to $SESSION_NAME (message pasted into running $RUNTIME)"
  exit 0
fi

# Agent is not running. Start a fresh interactive process.

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  # Tmux session exists but agent exited. Start agent again in the existing shell.
  CMD_FILE=$(mktemp /tmp/dispatch-cmd-XXXXXX)
  echo "$AGENT_CMD" > "$CMD_FILE"
  tmux load-buffer "$CMD_FILE"
  tmux paste-buffer -t "$SESSION_NAME"
  sleep 1
  tmux send-keys -t "$SESSION_NAME" Enter
  rm -f "$CMD_FILE"
else
  # No tmux session at all.
  if [ "$RUNTIME" = "codex" ] || [ "$RUNTIME" = "gemini" ]; then
    # Codex/Gemini: start a persistent bash shell, then launch the agent inside it.
    # This keeps the tmux session alive if the agent exits, and lets us handle
    # the trust prompt before pasting the message.
    tmux new-session -d -s "$SESSION_NAME" -c "$PROJECT_DIR" \
      "export DISCORD_CHANNEL_ID=$CHANNEL_ID WORKSTATION_DB_URL=postgresql://workstation:workstation@localhost:5433/workstation DISCORD_MESSAGE_ID=$MESSAGE_ID; exec bash"
    tmux set-environment -t "$SESSION_NAME" DISCORD_CHANNEL_ID "$CHANNEL_ID"
    tmux set-environment -t "$SESSION_NAME" WORKSTATION_DB_URL "postgresql://workstation:workstation@localhost:5433/workstation"
    if [ -n "$MESSAGE_ID" ]; then
      tmux set-environment -t "$SESSION_NAME" DISCORD_MESSAGE_ID "$MESSAGE_ID"
    fi
    sleep 1
    # Start the agent interactively inside the shell
    CMD_FILE=$(mktemp /tmp/dispatch-cmd-XXXXXX)
    echo "$AGENT_CMD" > "$CMD_FILE"
    tmux load-buffer "$CMD_FILE"
    tmux paste-buffer -t "$SESSION_NAME"
    sleep 1
    tmux send-keys -t "$SESSION_NAME" Enter
    rm -f "$CMD_FILE"
  else
    # Claude: agent is the session command (interactive process).
    tmux new-session -d -s "$SESSION_NAME" -c "$PROJECT_DIR" \
      "export DISCORD_CHANNEL_ID=$CHANNEL_ID WORKSTATION_DB_URL=postgresql://workstation:workstation@localhost:5433/workstation DISCORD_MESSAGE_ID=$MESSAGE_ID; $AGENT_CMD"
    tmux set-environment -t "$SESSION_NAME" DISCORD_CHANNEL_ID "$CHANNEL_ID"
    tmux set-environment -t "$SESSION_NAME" WORKSTATION_DB_URL "postgresql://workstation:workstation@localhost:5433/workstation"
    if [ -n "$MESSAGE_ID" ]; then
      tmux set-environment -t "$SESSION_NAME" DISCORD_MESSAGE_ID "$MESSAGE_ID"
    fi
  fi
fi

# Wait for agent to start up and be ready for input.
# Codex and Gemini both show trust prompts -- send Enter to dismiss.
if [ "$RUNTIME" = "codex" ] || [ "$RUNTIME" = "gemini" ]; then
  sleep 3
  # Dismiss the "Do you trust this directory?" prompt if it appears
  tmux send-keys -t "$SESSION_NAME" Enter
  sleep 5
else
  sleep 5
fi

# Paste the message into the now-running agent
echo "$FLAT_MESSAGE" > "$MSG_FILE"
tmux load-buffer "$MSG_FILE"
tmux paste-buffer -t "$SESSION_NAME"
sleep 1
tmux send-keys -t "$SESSION_NAME" Enter
sleep 0.3
tmux send-keys -t "$SESSION_NAME" Enter

rm -f "$MSG_FILE"

# Add eyes reaction to indicate message received
if [ -n "$MESSAGE_ID" ]; then
  bash "$HOME/.claude/bin/discord-react.sh" add "$CHANNEL_ID" "$MESSAGE_ID" eyes &
fi

# Log dispatch to audit
bash "$HOME/.claude/bin/audit-log.sh" dispatches \
  session_name="$SESSION_NAME" runtime="$RUNTIME" channel_id="$CHANNEL_ID" \
  message_preview="$(echo "$MESSAGE" | head -c 200)" &
# Auto-create task from dispatch
TASK_TITLE=$(echo "$MESSAGE" | head -c 100 | tr '\n' ' ')
bash "$HOME/.claude/bin/task-create.sh" "$TASK_TITLE" \
  --session "$SESSION_NAME" --channel "$CHANNEL_ID" --status pending &

echo "Dispatched to $SESSION_NAME (runtime: $RUNTIME, agent: ${AGENT:-default})"
