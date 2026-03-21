#!/bin/bash
# Morning Briefing - Posts a SecondBrain digest to Discord #hub
# Runs via cron at 8am daily

# PATH setup for cron environment
export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_ROOT="${SECOND_BRAIN_DIR:-$HOME/SecondBrain}"
LOG_FILE="$HOME/.claude/logs/morning-briefing.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "Starting morning briefing"

# Build the briefing prompt
PROMPT="You are generating a morning briefing. Do the following:

1. Search the SecondBrain vault at $VAULT_ROOT for all files with 'status: active' in their frontmatter.
2. Group results by folder: Projects, People, Ideas, Admin.
3. For each active item, extract the 'name' and 'next_action' from frontmatter.
4. Format the output EXACTLY as plain text (no markdown formatting, no code blocks):

-- Morning Briefing $(date '+%Y-%m-%d') --

ACTIVE PROJECTS:
- <name> | next: <next_action>

ACTIVE PEOPLE:
- <name> | next: <next_action>

ACTIVE IDEAS:
- <name> | next: <next_action>

ACTIVE ADMIN:
- <name> | next: <next_action>

If a section has no active items, write 'None' under it.
Output ONLY the briefing text, nothing else."

# Run claude with the prompt
BRIEFING=$(claude -p "$PROMPT" 2>>"$LOG_FILE")

if [ $? -ne 0 ] || [ -z "$BRIEFING" ]; then
  log "ERROR: Failed to generate briefing"
  bash "$SCRIPT_DIR/discord-notify.sh" "[Morning Briefing] Failed to generate -- check logs at $LOG_FILE"
  exit 1
fi

log "Briefing generated successfully"

# Post to Discord hub
bash "$SCRIPT_DIR/discord-notify.sh" "$BRIEFING"

log "Briefing posted to Discord"
