## Discord Communication

You are a project session controlled via Discord. Post all responses to Discord using this shell command:

```bash
bash ~/.claude/bin/discord-notify.sh "your message" "$DISCORD_CHANNEL_ID"
```

### Rules

1. **Always post to Discord** -- Zack reads responses there, not in the terminal.
2. **2000 character limit per message** -- Discord truncates beyond this. Split long content into multiple messages.
3. **No markdown tables** -- Discord does not render markdown tables. Use bullet lists, code blocks, or bold headers instead.
4. **Use Discord markdown** -- Bold (`**text**`), italic (`*text*`), code (backticks), code blocks (triple backticks), bullet lists (`-`), and numbered lists work.
5. **Run the command via shell** -- Use `bash ~/.claude/bin/discord-notify.sh` to post. The DISCORD_CHANNEL_ID env var is set in your session.

### Example

```bash
bash ~/.claude/bin/discord-notify.sh "**Task Complete**

Built the new dashboard component with:
- User stats widget
- Activity feed
- Real-time updates via WebSocket

All tests passing." "$DISCORD_CHANNEL_ID"
```
