#!/bin/bash
# council-research.sh -- Fan out research to Claude, Gemini, and Codex in parallel,
# then synthesize all responses into a unified report.
#
# Usage: council-research.sh <channel-id> "<prompt>" [topic-name] [timeout-secs]
#
# Creates 3 persistent tmux sessions (council-<topic>-claude, council-<topic>-gemini,
# council-<topic>-codex) that are visible to heartbeat and session monitoring.
# Waits for all 3 via tmux wait-for (zero-polling), then runs Claude synthesis.
# Results saved to research/<topic>/ and posted to Discord.

CHANNEL_ID="$1"
PROMPT="$2"
TOPIC="${3:-council-$(date +%s)}"
TIMEOUT="${4:-600}"

NOTIFY="$HOME/.claude/bin/discord-notify.sh"
WORKSPACE="$HOME/Documents/ZacksWorkspace"
RESULTS_DIR="/tmp/council/${TOPIC}"
RESEARCH_DIR="$WORKSPACE/research/${TOPIC}"

if [ -z "$CHANNEL_ID" ] || [ -z "$PROMPT" ]; then
  echo "Usage: council-research.sh <channel-id> \"<prompt>\" [topic-name] [timeout-secs]"
  exit 1
fi

mkdir -p "$RESULTS_DIR"
mkdir -p "$RESEARCH_DIR/findings"

# Write prompt to a temp file to avoid all shell escaping issues in tmux commands.
PROMPT_FILE="$RESULTS_DIR/prompt.txt"
cat > "$PROMPT_FILE" << 'PROMPT_TEMPLATE'
Research the following topic thoroughly using web search.

TOPIC: __TOPIC__

SPECIFIC QUESTION:
__PROMPT__

Instructions:
- Search the web for authoritative, recent sources
- For each finding, cite the source URL
- Note publication dates when available
- Organize findings by theme
- Flag any areas of uncertainty or conflicting information
- Keep response under 4000 words

Output as structured markdown with:
## Key Findings
## Detailed Analysis (by theme)
## Sources (URL - what it contributed)
PROMPT_TEMPLATE

# Replace placeholders with actual values
sed -i '' "s|__TOPIC__|${TOPIC}|g" "$PROMPT_FILE"
# Use a different delimiter for the prompt since it may contain special chars
awk -v prompt="$PROMPT" '{gsub(/__PROMPT__/, prompt); print}' "$PROMPT_FILE" > "$PROMPT_FILE.tmp"
mv "$PROMPT_FILE.tmp" "$PROMPT_FILE"

# Save prompt for the research record
cp "$PROMPT_FILE" "$RESEARCH_DIR/prompt.md"

bash "$NOTIFY" "**Council Research: ${TOPIC}**
Dispatching to Claude, Gemini, and Codex in parallel...
Timeout: ${TIMEOUT}s per agent" "$CHANNEL_ID"

# ============================================================
# Fan-out: Launch all 3 in persistent tmux sessions
# ============================================================
# Each session: runs the CLI headlessly, writes output to file, signals done.
# Sessions stay alive after completion so heartbeat/monitoring can see them.
# The session command is a shell that stays open after the work is done.

# --- Claude Code ---
SESSION_CLAUDE="council-${TOPIC}-claude"
tmux new-session -d -s "$SESSION_CLAUDE" -c "$WORKSPACE" \
  "echo '[council] Claude starting...'; \
   timeout $TIMEOUT claude --bare -p \"\$(cat $PROMPT_FILE)\" \
     --output-format text --dangerously-skip-permissions --max-turns 20 \
     > \"$RESULTS_DIR/claude.out\" 2>\"$RESULTS_DIR/claude.err\"; \
   echo \$? > \"$RESULTS_DIR/claude.exit\"; \
   echo '[council] Claude finished (exit '\$(cat $RESULTS_DIR/claude.exit)')'; \
   tmux wait-for -S done-${SESSION_CLAUDE}; \
   exec bash"

# --- Gemini CLI ---
SESSION_GEMINI="council-${TOPIC}-gemini"
tmux new-session -d -s "$SESSION_GEMINI" -c "$WORKSPACE" \
  "echo '[council] Gemini starting...'; \
   timeout $TIMEOUT gemini -p \"\$(cat $PROMPT_FILE)\" \
     --yolo \
     > \"$RESULTS_DIR/gemini.out\" 2>\"$RESULTS_DIR/gemini.err\"; \
   echo \$? > \"$RESULTS_DIR/gemini.exit\"; \
   echo '[council] Gemini finished (exit '\$(cat $RESULTS_DIR/gemini.exit)')'; \
   tmux wait-for -S done-${SESSION_GEMINI}; \
   exec bash"

# --- Codex CLI ---
SESSION_CODEX="council-${TOPIC}-codex"
tmux new-session -d -s "$SESSION_CODEX" -c "$WORKSPACE" \
  "echo '[council] Codex starting...'; \
   timeout $TIMEOUT codex exec --full-auto --search \
     -o \"$RESULTS_DIR/codex.out\" \
     \"\$(cat $PROMPT_FILE)\" \
     > /dev/null 2>\"$RESULTS_DIR/codex.err\"; \
   echo \$? > \"$RESULTS_DIR/codex.exit\"; \
   echo '[council] Codex finished (exit '\$(cat $RESULTS_DIR/codex.exit)')'; \
   tmux wait-for -S done-${SESSION_CODEX}; \
   exec bash"

echo "Council sessions launched: $SESSION_CLAUDE, $SESSION_GEMINI, $SESSION_CODEX"

# ============================================================
# Fan-in: Wait for all 3 to signal completion
# ============================================================
# Each wait-for blocks in the background; we wait on all PIDs.

tmux wait-for "done-${SESSION_CLAUDE}" &
PID_CLAUDE=$!
tmux wait-for "done-${SESSION_GEMINI}" &
PID_GEMINI=$!
tmux wait-for "done-${SESSION_CODEX}" &
PID_CODEX=$!

# Post progress as each completes
(wait $PID_CLAUDE 2>/dev/null && bash "$NOTIFY" "Council: Claude finished" "$CHANNEL_ID") &
(wait $PID_GEMINI 2>/dev/null && bash "$NOTIFY" "Council: Gemini finished" "$CHANNEL_ID") &
(wait $PID_CODEX 2>/dev/null && bash "$NOTIFY" "Council: Codex finished" "$CHANNEL_ID") &

# Wait for all three (with overall timeout safety net)
WAIT_START=$(date +%s)
OVERALL_TIMEOUT=$((TIMEOUT + 60))
ALL_DONE=false

while [ "$ALL_DONE" = false ]; do
  ELAPSED=$(( $(date +%s) - WAIT_START ))
  if [ $ELAPSED -ge $OVERALL_TIMEOUT ]; then
    bash "$NOTIFY" "Council: Overall timeout reached (${OVERALL_TIMEOUT}s). Proceeding with available results." "$CHANNEL_ID"
    break
  fi

  # Check if all exit files exist (meaning all agents finished)
  if [ -f "$RESULTS_DIR/claude.exit" ] && [ -f "$RESULTS_DIR/gemini.exit" ] && [ -f "$RESULTS_DIR/codex.exit" ]; then
    ALL_DONE=true
  else
    sleep 5
  fi
done

# Give a moment for the wait-for signals to propagate
sleep 2

# ============================================================
# Collect results and check what succeeded
# ============================================================

SUCCEEDED=""
FAILED=""
for agent in claude gemini codex; do
  EXIT_CODE=$(cat "$RESULTS_DIR/${agent}.exit" 2>/dev/null || echo "999")
  OUT_FILE="$RESULTS_DIR/${agent}.out"
  OUT_SIZE=0
  if [ -f "$OUT_FILE" ]; then
    OUT_SIZE=$(wc -c < "$OUT_FILE" | tr -d ' ')
  fi

  if [ "$EXIT_CODE" = "0" ] && [ "$OUT_SIZE" -gt 50 ]; then
    SUCCEEDED="$SUCCEEDED $agent"
    cp "$OUT_FILE" "$RESEARCH_DIR/findings/${agent}-response.md"
  else
    FAILED="$FAILED $agent(exit=$EXIT_CODE,size=${OUT_SIZE}b)"
    # Save error log for debugging
    if [ -f "$RESULTS_DIR/${agent}.err" ]; then
      cp "$RESULTS_DIR/${agent}.err" "$RESEARCH_DIR/findings/${agent}-error.log"
    fi
  fi
done

SUCCEEDED_COUNT=$(echo $SUCCEEDED | wc -w | tr -d ' ')

bash "$NOTIFY" "**Council: ${SUCCEEDED_COUNT}/3 agents completed**${FAILED:+
Failed:$FAILED}
Synthesizing results..." "$CHANNEL_ID"

# ============================================================
# Synthesis: Claude merges all outputs into unified report
# ============================================================

if [ "$SUCCEEDED_COUNT" -lt 1 ]; then
  bash "$NOTIFY" "**Council FAILED:** No agents produced usable output.
Logs at: $RESULTS_DIR" "$CHANNEL_ID"
  exit 1
fi

# Build the synthesis prompt from all successful outputs
SYNTH_PROMPT_FILE="$RESULTS_DIR/synthesis-prompt.txt"
cat > "$SYNTH_PROMPT_FILE" << 'SYNTH_HEADER'
You are synthesizing research from multiple AI agents that independently researched the same topic.
Each agent used different search engines and knowledge bases, so cross-referencing their findings
produces higher-confidence results than any single source.

Your job:
1. Identify CONSENSUS findings (mentioned by 2+ agents) -- these are HIGH CONFIDENCE
2. Surface UNIQUE INSIGHTS found by only one agent -- note which agent and why it matters
3. Flag CONTRADICTIONS between agents and evaluate evidence quality
4. Produce a unified report organized by THEME, not by agent
5. Collect ALL source URLs mentioned by any agent into a Sources section
6. Rate confidence: HIGH (all agree), MEDIUM (majority), LOW (disputed or single-source)

Format the output as a clean markdown research report with:
# Council Research: <topic>
## Executive Summary (3-5 bullet points)
## Key Findings (organized by theme, with confidence ratings)
## Detailed Analysis
## Areas of Disagreement
## Sources

SYNTH_HEADER

echo "" >> "$SYNTH_PROMPT_FILE"
echo "ORIGINAL RESEARCH QUESTION:" >> "$SYNTH_PROMPT_FILE"
echo "$PROMPT" >> "$SYNTH_PROMPT_FILE"
echo "" >> "$SYNTH_PROMPT_FILE"

for agent in $SUCCEEDED; do
  echo "=== ${agent^^} FINDINGS ===" >> "$SYNTH_PROMPT_FILE"
  cat "$RESULTS_DIR/${agent}.out" >> "$SYNTH_PROMPT_FILE"
  echo "" >> "$SYNTH_PROMPT_FILE"
  echo "=== END ${agent^^} ===" >> "$SYNTH_PROMPT_FILE"
  echo "" >> "$SYNTH_PROMPT_FILE"
done

echo "Produce the unified synthesis report now." >> "$SYNTH_PROMPT_FILE"

# Run synthesis through Claude
bash "$NOTIFY" "Council: Running synthesis..." "$CHANNEL_ID"

claude --bare -p "$(cat "$SYNTH_PROMPT_FILE")" \
  --output-format text --dangerously-skip-permissions \
  > "$RESULTS_DIR/synthesis.out" 2>/dev/null

SYNTH_EXIT=$?
if [ $SYNTH_EXIT -ne 0 ] || [ ! -s "$RESULTS_DIR/synthesis.out" ]; then
  bash "$NOTIFY" "**Council: Synthesis failed (exit $SYNTH_EXIT).** Individual findings saved to research/${TOPIC}/findings/" "$CHANNEL_ID"
  # Still save what we have
  echo "# Council Research: ${TOPIC}" > "$RESEARCH_DIR/README.md"
  echo "" >> "$RESEARCH_DIR/README.md"
  echo "Synthesis failed. See individual findings in findings/ directory." >> "$RESEARCH_DIR/README.md"
else
  cp "$RESULTS_DIR/synthesis.out" "$RESEARCH_DIR/README.md"
fi

# ============================================================
# Deliver: Post to Discord + git commit
# ============================================================

SYNTHESIS=$(cat "$RESEARCH_DIR/README.md")
SYNTH_SIZE=${#SYNTHESIS}

if [ "$SYNTH_SIZE" -le 1800 ]; then
  bash "$NOTIFY" "**COUNCIL COMPLETE: ${TOPIC}** (${SUCCEEDED_COUNT}/3 agents)

$SYNTHESIS" "$CHANNEL_ID"
else
  # Split into Discord-safe chunks at line boundaries
  # First message: header + beginning
  FIRST_PART=$(echo "$SYNTHESIS" | head -c 1700)
  bash "$NOTIFY" "**COUNCIL COMPLETE: ${TOPIC}** (${SUCCEEDED_COUNT}/3 agents)

$FIRST_PART" "$CHANNEL_ID"

  # Remaining chunks
  OFFSET=1701
  while [ $OFFSET -lt $SYNTH_SIZE ]; do
    CHUNK=$(echo "$SYNTHESIS" | tail -c +${OFFSET} | head -c 1800)
    CHUNK_LEN=${#CHUNK}
    if [ "$CHUNK_LEN" -gt 0 ]; then
      bash "$NOTIFY" "$CHUNK" "$CHANNEL_ID"
    fi
    OFFSET=$((OFFSET + 1800))
  done
fi

# Git commit the research
cd "$WORKSPACE"
git add "research/${TOPIC}/" 2>/dev/null
git commit -m "${TOPIC}: council research report (${SUCCEEDED_COUNT}/3 agents)" 2>/dev/null

# Clean up temp files (but keep tmux sessions alive for monitoring)
rm -rf "$RESULTS_DIR"

bash "$NOTIFY" "Council research saved to \`research/${TOPIC}/\`
Sessions still alive for monitoring: \`$SESSION_CLAUDE\`, \`$SESSION_GEMINI\`, \`$SESSION_CODEX\`" "$CHANNEL_ID"

echo "Council research complete: ${TOPIC}"
