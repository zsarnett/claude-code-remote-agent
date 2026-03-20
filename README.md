# Claude Code Remote Agent

Turn a Mac into a persistent, self-healing Claude Code workstation controlled remotely via Discord. Send messages from your phone or another computer, and Claude Code processes them autonomously -- writing code, running commands, deploying apps, and responding back to Discord.

## What This Does

- **Discord as a control plane**: Send messages to Discord channels, Claude Code receives and acts on them
- **Multi-project routing**: Each Discord channel maps to a project directory with its own isolated Claude Code session
- **Self-healing**: Auto-restart on crash, health checks every 5 minutes, auto-start on boot
- **Web dashboard**: Real-time status UI at `localhost:7777` showing sessions, system stats, and logs
- **Slack bridge**: Optional forwarding of Slack mentions/urgent messages to Discord
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
- Creates example config files
- Sets up cron jobs for health checks, git reports, and disk monitoring
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

### Optional (Slack Bridge)

**`~/.claude/channels/slack/config.json`** -- Configure Slack monitoring if you have Slack MCP tools set up.

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

### Dashboard

Open `http://localhost:7777` to see:
- Active tmux sessions with last output
- System stats (CPU, memory, disk)
- Discord channel map
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

### Self-Healing

- **Crash recovery**: `agent-loop.sh` wraps each session and auto-restarts on crash (up to 5 rapid crashes in 60 seconds)
- **External monitor**: `health-check.sh` runs via cron every 5 minutes and restarts the hub if it's down
- **Boot recovery**: LaunchAgent plist starts the hub automatically on login
- **Discord alerts**: All crash/restart events are posted to Discord `#hub`

### Hooks

Two Claude Code hooks power the system:

- **`post-to-discord.sh`** (Stop hook): Posts Claude's response to the correct Discord channel. Only fires for project sessions (when `DISCORD_CHANNEL_ID` env var is set).
- **`notify-agent-done.sh`** (Notification hook): Sends macOS notifications when Claude needs permission or has a question.

## File Structure

```
~/.claude/
  start-agent.sh              # Session launcher
  project-agent-instructions.md
  bin/
    agent-loop.sh              # Auto-restart wrapper
    dispatch-to-session.sh     # Message router
    discord-notify.sh          # Discord API poster
    discord-create-channel.sh  # Channel provisioner
    kill-project-session.sh    # Session terminator
    list-project-sessions.sh   # Session lister
    restart-agent.sh           # Self-restart helper
    health-check.sh            # Cron health monitor
    git-check.sh               # Nightly git report
    disk-check.sh              # Daily disk alert
    start-dashboard.sh         # Dashboard launcher
    slack-bridge.sh            # Slack bridge helper
    slack-bridge-instructions.md
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
  logs/
    health-check.log
    git-check.log
    disk-check.log
    launchd-agent.log
~/Library/LaunchAgents/
  com.claude.agent.plist       # Auto-start on login
```

## CLAUDE.md Integration

For the hub agent to know how to route messages, add routing instructions to your workspace's `CLAUDE.md`. See `examples/CLAUDE.md.example` for a template that includes:
- Discord message routing rules
- Project session dispatching
- Hub command handling
- Context management guidelines

## Cron Jobs

| Schedule | Job | Description |
|----------|-----|-------------|
| `*/5 * * * *` | health-check.sh | Checks if hub is running, restarts if down |
| `0 21 * * *` | git-check.sh | Reports uncommitted/unpushed work across repos |
| `0 8 * * *` | disk-check.sh | Alerts if disk usage exceeds 80% |

## Security Notes

- The bot token is stored in `~/.claude/channels/discord/.env` (gitignored)
- Access is restricted via `access.json` allowlist -- only your Discord user ID can send commands
- Claude Code runs with `--dangerously-skip-permissions` for autonomous operation -- ensure your machine is secured
- All channels are created as private by default

## Troubleshooting

**Agent won't start**: Check `~/.claude/logs/launchd-agent.log` and ensure tmux is installed.

**Discord messages not arriving**: Verify the bot token in `.env`, check that the bot is in the server, and ensure Message Content Intent is enabled.

**Project session not responding**: Run `claude-agents` to check if the session exists. Try `claude-stop <name>` and send the message again to create a fresh session.

**Dashboard not loading**: Run `bash ~/.claude/bin/start-dashboard.sh` manually and check for errors. Ensure port 7777 is free.

## License

MIT
