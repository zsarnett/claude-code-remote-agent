# Claude Code Remote Agent

Turn a Mac into a persistent, self-healing Claude Code workstation controlled remotely via Discord. Send messages from your phone or another computer, and Claude Code processes them autonomously -- writing code, running commands, deploying apps, and responding back to Discord.

## What This Does

- **Discord as a control plane**: Send messages to Discord channels, Claude Code receives and acts on them
- **Multi-project routing**: Each Discord channel maps to a project directory with its own isolated Claude Code session
- **Self-healing**: Auto-restart on crash, health checks every 5 minutes, auto-start on boot
- **Web dashboard**: Real-time status UI at `localhost:7777` showing sessions, system stats, heartbeat, SecondBrain, and logs
- **Slack bridge**: Optional forwarding of Slack mentions/urgent messages to Discord
- **Heartbeat system**: Periodic automated checks (git repos, disk, Docker, sessions) with Discord alerts
- **Scheduler**: One-shot timers and recurring cron jobs for Discord reminders
- **Zoom integration**: OAuth helpers and transcript access via MCP server
- **Outlook/Teams integration**: Microsoft 365 email, calendar, tasks, and Teams via MCP
- **SecondBrain integration**: Morning briefings, inbox processing, and knowledge vault queries
- **Monitoring**: Nightly git repo checks, disk usage alerts, crash notifications

## Architecture

```
Discord #hub       --> Hub session (handles directly)
Discord #project   --> dispatch-to-session.sh --> tmux claude-<project>
                                                    |
                                                    v
                                              discord-notify.sh --> Discord #project
```

The **hub session** is an orchestrator. It receives Discord messages and either:
- Handles them directly (system management, smart home, general tasks)
- Dispatches them to a dedicated **project session** via tmux

Each project session runs in its own tmux window with its own Claude Code context. When a project session finishes responding, a Stop hook automatically posts the response back to Discord.

## Prerequisites

- **macOS** (for LaunchAgents; Linux users can adapt with systemd)
- **tmux** (`brew install tmux`)
- **jq** (`brew install jq`)
- **Node.js** (for the dashboard)
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`)
- A **Discord bot** with message content intent enabled

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** tab, click "Add Bot"
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Copy the bot token
6. Go to **OAuth2 > URL Generator**, select `bot` scope with permissions: `Send Messages`, `Read Message History`, `Manage Channels`
7. Use the generated URL to invite the bot to your server
8. Create a category in your Discord server (e.g., "Claude Agent") for the channels
9. Create a `#hub` channel in that category

## Installation

```bash
git clone https://github.com/youruser/claude-code-remote-agent.git
cd claude-code-remote-agent
bash install.sh
```

The install script:
- Copies all scripts to `~/.claude/bin/`
- Sets up hooks in `~/.claude/hooks/`
- Installs the dashboard
- Creates example config files (Discord, Slack, Zoom)
- Copies a HEARTBEAT.md template to your home directory
- Sets up cron jobs for health checks, git reports, disk monitoring, heartbeat, and morning briefings
- Installs a LaunchAgent for auto-start on login

## Configuration

After running `install.sh`, edit these files:

### Required

**`~/.claude/channels/discord/.env`**
```
DISCORD_BOT_TOKEN=your-bot-token-here
```

**`~/.claude/channels/discord/channel-map.json`**
```json
{
  "guildId": "YOUR_GUILD_ID",
  "categoryId": "YOUR_CATEGORY_ID",
  "channels": {
    "YOUR_HUB_CHANNEL_ID": {
      "name": "hub",
      "dir": "/path/to/your/workspace"
    }
  },
  "defaultDir": "/path/to/your/workspace"
}
```

**`~/.claude/channels/discord/access.json`**
```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["YOUR_DISCORD_USER_ID"],
  "groups": {
    "YOUR_HUB_CHANNEL_ID": {
      "requireMention": false,
      "allowFrom": ["YOUR_DISCORD_USER_ID"]
    }
  },
  "pending": {}
}
```

**`~/.claude/bin/discord-notify.sh`** -- Update the default channel ID on line 7.

**`~/.claude/bin/discord-create-channel.sh`** -- Update BOT_ID and OWNER_ID.

### Optional: Slack Bridge

**`~/.claude/channels/slack/config.json`** -- Configure Slack monitoring if you have Slack MCP tools set up. See `bin/slack-bridge-instructions.md` for the full procedure.

### Optional: Zoom Transcripts

**`~/.claude/channels/zoom/config.json`** -- Add your Zoom OAuth client ID and secret. See `bin/zoom-setup-instructions.md` for step-by-step setup.

Use `bin/zoom-auth.sh` to complete the OAuth flow, and `bin/zoom-token.sh` to get a valid access token (auto-refreshes).

### Optional: Outlook / Microsoft 365

See `bin/outlook-setup-instructions.md` for Azure app registration and MCP server setup. Provides email, calendar, contacts, tasks, and Teams integration.

### Optional: SecondBrain

If you use a markdown-based knowledge vault (SecondBrain):
- Set the `SECOND_BRAIN_DIR` environment variable to your vault root
- Set the `HEARTBEAT_FILE` environment variable to your HEARTBEAT.md path
- The morning briefing cron (`morning-briefing.sh`) will scan for active items and post a daily digest

### Optional: Heartbeat

Edit `~/HEARTBEAT.md` (copied during install) to define your periodic checks. The heartbeat runs every 30 minutes and only posts to Discord when something needs attention. See `examples/HEARTBEAT.md.example` for the template.

## Usage

### Start the agent

```bash
# Start the main hub session
claude-agent

# Or start a specific project session
claude-agent myproject /path/to/project
```

### Shell commands

```bash
claude-agent                    # start the hub session
claude-agent <name>             # start a named project session
claude-agent <name> /path       # start in a specific directory
claude-agents                   # list all running sessions
claude-attach <name>            # attach to a tmux session
claude-stop <name>              # kill a specific session
claude-stop --all               # kill all sessions
```

### Add a project channel

From Discord `#hub`, tell Claude: "spin up a channel for myproject"

Or manually:
```bash
bash ~/.claude/bin/discord-create-channel.sh myproject /path/to/MyProject
```

### Clear a project's context

From Discord `#hub`: "clear context for myproject"

Or:
```bash
bash ~/.claude/bin/kill-project-session.sh myproject <channel-id>
```

### Set timers and reminders

```bash
# One-shot timer
bash ~/.claude/bin/schedule.sh timer 30m YOUR_CHANNEL_ID "Reminder: check deploy status"
bash ~/.claude/bin/schedule.sh timer 2h YOUR_CHANNEL_ID "Time to review PRs"

# Recurring cron
bash ~/.claude/bin/schedule.sh cron "0 9 * * *" YOUR_CHANNEL_ID "Good morning! Check email and Slack."

# List active timers and crons
bash ~/.claude/bin/schedule.sh list

# Cancel a timer
bash ~/.claude/bin/schedule.sh cancel <pid>
```

### Dashboard

Open `http://localhost:7777` to see:
- Active tmux sessions with last terminal output
- System stats (CPU, memory, disk)
- Discord channel map
- Heartbeat status
- SecondBrain active items (Brain tab)
- Cron job schedule
- Recent log activity

## How It Works

### Message Flow

1. You send a message to a Discord channel (e.g., `#myproject`)
2. The Discord MCP plugin delivers it to the hub Claude Code session
3. Hub checks `channel-map.json` to identify the project
4. Hub runs `dispatch-to-session.sh` to route the message to a project tmux session
5. The project session processes the task autonomously
6. When done, the Stop hook (`post-to-discord.sh`) posts the response back to Discord

### Dispatch System

The dispatch script (`dispatch-to-session.sh`) uses tmux's `load-buffer` + `paste-buffer` approach instead of `send-keys` to avoid quoting issues with complex messages. Messages are written to a temp file, loaded into tmux's buffer, pasted into the target session, and then Enter is sent.

### Self-Healing

- **Crash recovery**: `agent-loop.sh` wraps each session and auto-restarts on crash (up to 5 rapid crashes in 60 seconds)
- **External monitor**: `health-check.sh` runs via cron every 5 minutes and restarts the hub if it's down
- **Boot recovery**: LaunchAgent plist starts the hub automatically on login
- **Discord alerts**: All crash/restart events are posted to Discord `#hub`

### Heartbeat

The heartbeat system (`heartbeat.sh`) runs every 30 minutes and reads a `HEARTBEAT.md` checklist. Claude evaluates each check by running real commands (git status, df, docker ps, tmux list-sessions, etc.) and only posts to Discord when something needs attention. If everything is fine, it stays silent.

### Hooks

Two Claude Code hooks power the system:

- **`post-to-discord.sh`** (Stop hook): Posts Claude's response to the correct Discord channel. Only fires for project sessions (when `DISCORD_CHANNEL_ID` env var is set).
- **`notify-agent-done.sh`** (Notification hook): Sends macOS notifications when Claude needs permission or has a question.

## File Structure

```
~/.claude/
  start-agent.sh              # Session launcher
  project-agent-instructions.md
  timers/                     # Active timer state files
  bin/
    agent-loop.sh              # Auto-restart wrapper
    dispatch-to-session.sh     # Message router (tmux load-buffer approach)
    discord-notify.sh          # Discord API poster
    discord-create-channel.sh  # Channel provisioner
    kill-project-session.sh    # Session terminator
    list-project-sessions.sh   # Session lister
    restart-agent.sh           # Self-restart helper
    health-check.sh            # Cron health monitor
    heartbeat.sh               # Periodic heartbeat checks
    schedule.sh                # Timer and cron scheduler
    morning-briefing.sh        # SecondBrain daily digest
    git-check.sh               # Nightly git report
    disk-check.sh              # Daily disk alert
    start-dashboard.sh         # Dashboard launcher
    slack-bridge.sh            # Slack bridge helper
    slack-bridge-instructions.md
    zoom-auth.sh               # Zoom OAuth flow
    zoom-token.sh              # Zoom token auto-refresh
    zoom-setup-instructions.md # Zoom MCP server setup
    outlook-setup-instructions.md  # Outlook MCP setup
  hooks/
    post-to-discord.sh         # Stop hook (auto-post to Discord)
    notify-agent-done.sh       # macOS notification hook
  dashboard/
    server.js                  # Express dashboard on port 7777
    package.json
  channels/
    discord/
      .env                     # Bot token
      channel-map.json         # Channel-to-project mapping
      access.json              # Access control
    slack/
      config.json              # Slack bridge config
    zoom/
      config.json              # Zoom OAuth config
      token.json               # Zoom access/refresh tokens (auto-managed)
  logs/
    health-check.log
    heartbeat.log
    morning-briefing.log
    git-check.log
    disk-check.log
    launchd-agent.log
~/Library/LaunchAgents/
  com.claude.agent.plist       # Auto-start on login
~/HEARTBEAT.md                 # Heartbeat checklist (customizable)
```

## CLAUDE.md Integration

For the hub agent to know how to route messages, add routing instructions to your workspace's `CLAUDE.md`. See `examples/CLAUDE.md.example` for a template that includes:
- Discord message routing rules
- Project session dispatching
- Hub command handling (including scheduler and Slack bridge)
- SecondBrain integration
- Context management guidelines

## Cron Jobs

| Schedule | Job | Description |
|----------|-----|-------------|
| `*/5 * * * *` | health-check.sh | Checks if hub is running, restarts if down |
| `*/30 * * * *` | heartbeat.sh | Runs HEARTBEAT.md checks, alerts on issues |
| `0 8 * * 1-5` | morning-briefing.sh | Posts SecondBrain digest to Discord (weekdays) |
| `0 21 * * *` | git-check.sh | Reports uncommitted/unpushed work across repos |
| `0 8 * * *` | disk-check.sh | Alerts if disk usage exceeds 80% |

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDE_AGENT_WORKSPACE` | Default workspace directory | `$HOME/Documents` |
| `DISCORD_HUB_CHANNEL_ID` | Hub channel for heartbeat alerts | (set in discord-notify.sh) |
| `HEARTBEAT_FILE` | Path to HEARTBEAT.md | `$HOME/HEARTBEAT.md` |
| `SECOND_BRAIN_DIR` | Path to SecondBrain vault | `$HOME/SecondBrain` |

## Security Notes

- The bot token is stored in `~/.claude/channels/discord/.env` (gitignored)
- Zoom and Outlook credentials are in their respective config files (gitignored)
- Access is restricted via `access.json` allowlist -- only your Discord user ID can send commands
- Claude Code runs with `--dangerously-skip-permissions` for autonomous operation -- ensure your machine is secured
- All channels are created as private by default

## Troubleshooting

**Agent won't start**: Check `~/.claude/logs/launchd-agent.log` and ensure tmux is installed.

**Discord messages not arriving**: Verify the bot token in `.env`, check that the bot is in the server, and ensure Message Content Intent is enabled.

**Project session not responding**: Run `claude-agents` to check if the session exists. Try `claude-stop <name>` and send the message again to create a fresh session.

**Messages garbled in project sessions**: The dispatch system uses `tmux load-buffer` + `paste-buffer` to avoid quoting issues. If you still see problems, check that your message does not contain null bytes.

**Dashboard not loading**: Run `bash ~/.claude/bin/start-dashboard.sh` manually and check for errors. Ensure port 7777 is free.

**Heartbeat not running**: Check `~/.claude/logs/heartbeat.log`. Ensure `HEARTBEAT_FILE` points to an existing file.

**Zoom auth failing**: Run `bash ~/.claude/bin/zoom-auth.sh` manually and check that your config.json has the correct client_id and redirect_uri.

## License

MIT
