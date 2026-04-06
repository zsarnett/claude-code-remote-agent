## Discord Communication (Project Sessions)

You are a project session controlled via Discord. Post all responses to Discord using the shell script below.

### How to Post to Discord

Use this command (DISCORD_CHANNEL_ID is in your environment):
```bash
# Text only
bash ~/.claude/bin/discord-notify.sh "your message" "$DISCORD_CHANNEL_ID"

# Text with screenshot/file attachments
bash ~/.claude/bin/discord-notify.sh "your message" "$DISCORD_CHANNEL_ID" /path/to/screenshot.png

# Multiple files
bash ~/.claude/bin/discord-notify.sh "your message" "$DISCORD_CHANNEL_ID" /tmp/shot1.png /tmp/shot2.png
```

### Rules

1. **Always post to Discord** -- Zack reads responses there, not in the terminal.
2. **2000 character limit per message** -- Discord truncates beyond this. Split long content into multiple messages.
3. **No markdown tables** -- Discord does not render markdown tables. Use these instead:
   - Bullet lists for structured data
   - Code blocks (triple backticks) for aligned columnar data
   - Bold headers with bullet points underneath
   - Numbered lists for sequential items
4. **Split long output** -- If your response is longer than ~1800 chars, break it into multiple discord-notify calls with clear section headers.
5. **Use Discord markdown** -- Bold (`**text**`), italic (`*text*`), code (`\`text\``), code blocks (triple backticks), bullet lists (`-`), and numbered lists work.
6. **Never ask Zack about Discord/Slack MCP tools** -- You don't have the Discord plugin. Use discord-notify.sh.
7. **Status reaction** -- On your first response to a new message, run this before posting:
   ```bash
   if [ -n "$DISCORD_MESSAGE_ID" ] && [ -n "$DISCORD_CHANNEL_ID" ]; then
     bash ~/.claude/bin/discord-react.sh remove "$DISCORD_CHANNEL_ID" "$DISCORD_MESSAGE_ID" eyes
     bash ~/.claude/bin/discord-react.sh add "$DISCORD_CHANNEL_ID" "$DISCORD_MESSAGE_ID" brain
   fi
   ```
   This swaps the eyes (received) reaction to brain (processing).

### CRITICAL: No External Service Posts Without Approval

NEVER post to Slack, send emails, post to Teams, or interact with any external-facing service without Zack's explicit approval. Only Discord (via discord-notify.sh) is allowed for autonomous communication. If discord-notify.sh is unavailable, ask Zack via Discord how to communicate -- do NOT fall back to Slack or other services.

### Browser Testing

Do NOT use Claude-in-Chrome browser tools -- those connect to Zack's personal computer, not this workstation. Use **Playwright MCP tools** (`mcp__plugin_playwright_playwright__*`) instead for browser testing -- Playwright runs its own browser locally on this machine.

### Example: Posting a Long Response

```bash
bash ~/.claude/bin/discord-notify.sh "**Time Entry Summary: Week of March 16-20**

All times in Central Time (CT).

**Flags for Review:**
- Two Adeptia AI Demo Day events Monday (3:00-5:00 PM CT) -- did you attend both?
- Shazamme sync overlap Tuesday (2:00-3:00 PM CT) -- counted as combined 1.0h" "$DISCORD_CHANNEL_ID"

bash ~/.claude/bin/discord-notify.sh "**By Category:**

**Adeptia - Product Management | SOW#13**
- AI Demo Day Monday: 2.0h
- Sprint Review Wednesday: 1.0h
- Total: 3.0h

**DataVysta - AI Engineering | MCP Project**
- Sync Tuesday: 1.0h
- Architecture Review Thursday: 1.5h
- Total: 2.5h" "$DISCORD_CHANNEL_ID"
```
