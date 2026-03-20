# Slack-to-Discord Bridge Instructions

These instructions tell Claude Code how to perform a Slack bridge check.
When the user says "check Slack", "bridge Slack", or "forward Slack messages",
follow this procedure.

## Config

- Config file: `~/.claude/channels/slack/config.json`
- Discord notify script: `~/.claude/bin/discord-notify.sh`
- Bridge helper script: `~/.claude/bin/slack-bridge.sh`

## Procedure: Full Bridge Check

### Step 1 -- Load Config

Read `~/.claude/channels/slack/config.json` to get the list of channels,
urgent keywords, and forwarding rules.

### Step 2 -- Search for Mentions and DMs

Use the Slack MCP tools to find messages relevant to you:

```
mcp__claude_ai_Slack__slack_search_public_and_private
  query: "from:<anyone> <@YOUR_SLACK_USER_ID>"
```

This finds messages that mention you across all accessible channels.

### Step 3 -- Check Each Monitored Channel

For each channel in `channels_to_monitor`:

1. Search for the channel:
   ```
   mcp__claude_ai_Slack__slack_search_channels
     query: "<channel_name>"
     channel_types: "public_channel,private_channel"
   ```

2. Read recent messages from the channel:
   ```
   mcp__claude_ai_Slack__slack_read_channel
     channel: "<channel_id>"
     limit: 20
   ```

3. Apply filtering rules:
   - If `forward_all` is true: forward every message.
   - Otherwise, check each message for:
     - Direct mentions of you
     - Any of the `urgent_keywords` from config
     - Threads you have participated in

### Step 4 -- Forward to Discord

For each message that passes the filter, forward it to Discord using:

```bash
~/.claude/bin/slack-bridge.sh --notify "#channel-name" "sender-name" "message text"
```

Or call the discord-notify script directly:

```bash
~/.claude/bin/discord-notify.sh "[Slack] #channel | sender: message text"
```

### Step 5 -- Report

After checking all channels, report to the user:
- How many channels were checked
- How many messages were forwarded
- Any errors encountered (e.g., channels not found, permission issues)

## Formatting Rules

When forwarding messages to Discord, use this format:

```
[Slack] #channel-name | sender-display-name: message text here
```

- Truncate messages longer than 1500 characters
- Include the channel name and sender for context
- For threaded replies, add "(thread)" after the channel name:
  ```
  [Slack] #channel-name (thread) | sender: reply text
  ```

## Urgency Levels

Messages are categorized by urgency for prioritization:

- **HIGH**: Direct mentions, DMs, messages in high-priority channels,
  messages containing urgent keywords
- **MEDIUM**: Messages in medium-priority channels that match keyword filters
- **LOW**: Messages in low-priority channels that match filters

When forwarding high-urgency messages, prepend the Discord message with `[!]`:

```
[!] [Slack] #alerts | monitoring-bot: Production database CPU at 95%
```

## On-Demand Single Channel Check

If the user asks to check a specific channel:

1. Search for it with `slack_search_channels` (always include `channel_types: "public_channel,private_channel"`)
2. Read recent messages with `slack_read_channel`
3. Apply the same filtering and forwarding rules
4. Report results

## Adding Channels

To add a new channel to monitor, edit `~/.claude/channels/slack/config.json`
and add an entry to the `channels_to_monitor` array:

```json
{
  "name": "new-channel",
  "priority": "medium",
  "forward_all": false,
  "notes": "Description of what to forward"
}
```
