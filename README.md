# Claude Code Remote Agent

Turn a Mac into a persistent, self-healing Claude Code workstation controlled remotely via Discord. Send messages from your phone or another computer, and Claude Code processes them autonomously -- writing code, running commands, deploying apps, and responding back to Discord.

## What This Does

- **Discord as a control plane**: Send messages to Discord channels, Claude Code receives and acts on them
- **Multi-project routing**: Each Discord channel maps to a project directory with its own isolated Claude Code session
- **Multi-runtime support**: Route work to Claude Code, OpenAI Codex, or Google Gemini CLI per-request
- **Council research**: Fan out the same question to Claude, Codex, and Gemini in parallel, then synthesize a unified report
- **Self-healing**: Auto-restart on crash, health checks every 5 minutes, auto-start on boot
- **Web dashboard**: Real-time status UI at `localhost:7777` showing sessions, system stats, heartbeat, SecondBrain, and logs
- **Leadership intelligence team**: AI CSO, COO, CMO, and Client Intel specialists that research and report to dedicated audit channels
- **Helper sessions**: Persistent sessions for SecondBrain, communications (email/Slack/Zoom), Home Assistant, and infrastructure
- **Slack bridge**: Optional forwarding of Slack mentions/urgent messages to Discord
- **Heartbeat system**: Periodic automated checks (git repos, disk, Docker, sessions) with Discord alerts
- **Scheduler**: One-shot timers and recurring cron jobs for Discord reminders
- **Task board**: PostgreSQL-backed task tracking with create/update/list scripts for coordinating multi-session work
- **Persistent memory**: Semantic memory MCP server with vector store, local embeddings, time decay, and background consolidation
- **MCP services**: LaunchAgent-managed MCP servers (memory, Slack, Zoom, Outlook, Home Assistant, Google Calendar, SSH)
- **Zoom integration**: OAuth helpers and transcript access via MCP server
- **Outlook/Teams integration**: Microsoft 365 email, calendar, tasks, and Teams via MCP
- **SecondBrain integration**: Morning briefings, inbox processing, and knowledge vault queries
- **Architect agent**: Upload a spec via Discord, get a design critique, phased plan, and auto-built app with Playwright E2E testing, user story validation, and screenshot-based design review
- **Researcher agent**: Deep-dive research with parallel agent waves, rabbit hole recursion, and auto-published results to GitHub
- **Monitoring**: Nightly git repo checks, disk usage alerts, crash notifications

## Architecture

```
Discord #hub       --> Hub session (pure router -- detects intent, dispatches)
                         |
                         +--> Project sessions:     claude-<name>, codex-<name>, gemini-<name>
                         +--> Helper sessions:       secondbrain, comms, ha, infra
                         +--> Specialized agents:    architect, researcher, leadership
                         +--> Council research:      claude + codex + gemini in parallel --> synthesis
                         |
Discord #project   --> dispatch-to-session.sh --> tmux <runtime>-<project>
                                                    |
                                                    v
                                              discord-notify.sh --> Discord #project
```

### Hub Session

The **hub** is a pure router running the `hub` agent definition. It receives every Discord message and either:
- Handles trivial commands inline (list sessions, spin up channels, schedule reminders)
- Dispatches to a **project session** via `dispatch-to-session.sh`
- Dispatches to a **helper session** (secondbrain, comms, ha, infra)
- Dispatches to a **specialized agent** (architect, researcher, leadership)
- Kicks off **council research** (multi-LLM parallel research)

The hub never does project work itself.

### Multi-Runtime Sessions

Each project can have sessions from multiple runtimes simultaneously, sharing the same working directory and Discord channel:

| Runtime | Session prefix | Mode | CLI |
|---------|---------------|------|-----|
| Claude Code | `claude-<name>` | `--dangerously-skip-permissions` | `claude` |
| OpenAI Codex | `codex-<name>` | `--full-auto` | `codex` |
| Google Gemini | `gemini-<name>` | `--yolo` | `gemini` |

Dispatch with the runtime argument: `dispatch-to-session.sh <name> <dir> <channel> "<msg>" [agent] [runtime]`

### Helper Sessions

Persistent sessions that handle specific domains. They maintain context between messages:

- **`secondbrain`** -- Knowledge vault operations (notes, queries, inbox, status updates)
- **`comms`** -- Email (Outlook), Slack bridge, Zoom transcripts
- **`ha`** -- Home Assistant / smart home control
- **`infra`** -- Script fixes, hook edits, dashboard issues

### Leadership Intelligence Team

A structured AI leadership team with a router and specialist subagents:

- **`#leadership`** channel receives requests, dispatches to specialists
- **CSO** (Chief Strategy Officer) -- competitive intelligence, market positioning, AI opportunities
- **COO** (Chief Operating Officer) -- project analysis, AI integration scoring, capacity planning
- **CMO** (Chief Marketing Officer) -- thought leadership content, competitor content analysis
- **Client Intel** -- client research, vertical trends, meeting prep, upsell opportunities

Each specialist posts detailed findings to its own audit channel (`#cso`, `#coo`, `#cmo`, `#client-intel`), saves to SecondBrain, and returns a summary to the leadership router.

### Council Research

Fan out a question to Claude, Codex, and Gemini in parallel, then synthesize:

```bash
bash council-research.sh <channel-id> "<prompt>" [topic-name] [timeout-secs]
```

Creates 3 tmux sessions (`council-<topic>-claude`, `council-<topic>-gemini`, `council-<topic>-codex`), waits for all via `tmux wait-for` (zero-polling), runs Claude synthesis, saves to `research/<topic>/`, and posts results to Discord.

### Specialized Agents

Agent definitions live in `agents/` and are selected by the hub based on intent detection:

- **Architect** (`agents/architect.md`): Full app lifecycle from spec to running code. Reads specs, critiques them, asks questions via Discord, produces a phased plan, waits for approval, then auto-builds using agent teams with Playwright E2E testing per phase.

- **Researcher** (`agents/researcher.md`): Recursive deep research. Breaks a topic into branches, spawns parallel agents, synthesizes findings, scores rabbit holes, and recurses up to 3 waves. Pushes to GitHub and posts summary to Discord.

- **Frontend Developer** (`agents/frontend-developer.md`): React/Vue/Angular component building, accessibility, state management, real-time features.

- **UI Designer** (`agents/ui-designer.md`): Design systems, component specs, accessibility audits, developer handoff.

- **QA Expert** (`agents/qa-expert.md`): Test strategy, automation, defect management, quality metrics.

- **Slack Synthesizer** (`agents/slack-synthesizer.md`): Processes staged Slack content into structured knowledge base documents.

## Prerequisites

- **macOS** (for LaunchAgents; Linux users can adapt with systemd)
- **tmux** (`brew install tmux`)
- **jq** (`brew install jq`)
- **Node.js** (for the dashboard and MCP servers)
- **PostgreSQL** (via Docker -- see `docker-compose.yml`)
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`)
- A **Discord bot** with message content intent enabled

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** tab, click "Add Bot"
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Copy the bot token
6. Go to **OAuth2 > URL Generator**, select `bot` scope with permissions: `Send Messages`, `Read Message History`, `Manage Channels`, `Add Reactions`
7. Use the generated URL to invite the bot to your server
8. Create a category in your Discord server (e.g., "Claude Agent") for the channels
9. Create a `#hub` channel in that category

## Installation

```bash
git clone https://github.com/zsarnett/claude-code-remote-agent.git
cd claude-code-remote-agent
bash install.sh
```

The install script:
- Symlinks all scripts to `~/.claude/bin/`
- Sets up hooks in `~/.claude/hooks/`
- Copies agent definitions to `~/.claude/agents/`
- Installs the dashboard
- Creates example config files (Discord, Slack, Zoom)
- Copies a HEARTBEAT.md template to your home directory
- Sets up cron jobs for health checks, git reports, disk monitoring, heartbeat, and morning briefings
- Installs a LaunchAgent for auto-start on login
- Starts the PostgreSQL database via Docker (for task board)
- Initializes the database schema

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

### Optional: MCP Services (LaunchAgent-managed)

The `mcp-services/` directory contains LaunchAgent plist templates for long-running MCP servers:

- `com.mcp.memory.plist` -- Semantic memory server
- `com.mcp.slack-user.plist` -- Slack MCP
- `com.mcp.zoom-transcripts.plist` -- Zoom transcript MCP
- `com.mcp.outlook-mcp.plist` -- Outlook/Teams MCP
- `com.mcp.hass-mcp.plist` -- Home Assistant MCP
- `com.mcp.google-calendar.plist` -- Google Calendar MCP
- `com.mcp.ssh-manager.plist` -- SSH connection manager

Install all: `bash mcp-services/install-mcp-services.sh`
Uninstall: `bash mcp-services/uninstall-mcp-services.sh`

### Optional: Memory MCP Server

The Memory MCP server provides persistent semantic memory across Claude Code sessions. See `mcp-servers/memory-server/README.md` for full documentation.

### Optional: SecondBrain

If you use a markdown-based knowledge vault (SecondBrain):
- Set the `SECOND_BRAIN_DIR` environment variable to your vault root
- Set the `HEARTBEAT_FILE` environment variable to your HEARTBEAT.md path
- The morning briefing cron (`morning-briefing.sh`) will scan for active items and post a daily digest

### Optional: Heartbeat

Edit `~/HEARTBEAT.md` (copied during install) to define your periodic checks. The heartbeat runs every 30 minutes and only posts to Discord when something needs attention. See `examples/HEARTBEAT.md.example` for the template.

### Optional: Settings

See `examples/settings.json` for a reference Claude Code settings file with hooks, plugins, and status line configuration.

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

### Task board

```bash
# Create a task
bash ~/.claude/bin/task-create.sh "Implement auth" --description "Add JWT auth" --session myproject

# Update task status
bash ~/.claude/bin/task-update.sh <task-id> --status in_progress

# List tasks
bash ~/.claude/bin/task-list.sh
bash ~/.claude/bin/task-list.sh --session myproject --status pending
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

Arguments: `dispatch-to-session.sh <name> <dir> <channel-id> <message> [agent] [runtime]`

- **agent**: Optional agent definition name (e.g., `architect`, `researcher`, `leadership`)
- **runtime**: Optional runtime (`claude` default, `codex`, or `gemini`)

### Self-Healing

- **Crash recovery**: `agent-loop.sh` wraps each session and auto-restarts on crash (up to 5 rapid crashes in 60 seconds)
- **External monitor**: `health-check.sh` runs via cron every 5 minutes and restarts the hub if it's down
- **Boot recovery**: LaunchAgent plist starts the hub automatically on login
- **Orphan cleanup**: `stop-cleanup-orphans.sh` runs on Stop hook to clean up orphaned tmux sessions
- **Discord alerts**: All crash/restart events are posted to Discord `#hub`

### Heartbeat

The heartbeat system (`heartbeat.sh`) runs every 30 minutes and reads a `HEARTBEAT.md` checklist. Claude evaluates each check by running real commands (git status, df, docker ps, tmux list-sessions, etc.) and only posts to Discord when something needs attention. If everything is fine, it stays silent.

### Hooks

Claude Code hooks power the system:

- **`post-to-discord.sh`** (Stop hook): Posts Claude's response to the correct Discord channel
- **`memory-on-stop.sh`** (Stop hook): Extracts and persists session memory on stop
- **`memory-on-compact.sh`** (PostCompact hook): Extracts memory when context is compacted
- **`context-report-on-stop.sh`** (Stop hook): Generates context continuity report for session resumption
- **`stop-cleanup-orphans.sh`** (Stop hook): Cleans up orphaned tmux sessions
- **`notify-agent-done.sh`** (Notification hook): Sends macOS notifications when Claude needs permission or has a question

### Constitution

The `constitution.md` defines immutable principles that apply to all sessions:
- Never post to external services without explicit approval
- Never auto-resolve merge conflicts
- Never delete user data without approval
- Never use mock data or placeholders without approval
- Always test user-facing features with Playwright before reporting done
- Always sync with git before starting work

## File Structure

```
claude-code-remote-agent/
  start-agent.sh              # Session launcher (aliased to claude-agent)
  install.sh                  # One-command installer
  constitution.md             # Immutable operating principles
  quality-rules.md            # Quality standards (no mocks, testing required)
  docker-compose.yml          # PostgreSQL for task board
  project-agent-instructions.md
  agents/
    hub.md                     # Pure router agent definition
    architect.md               # Spec-to-app agent with Playwright testing
    researcher.md              # Deep research with parallel agents
    leadership.md              # Leadership team router
    cso.md                     # Chief Strategy Officer specialist
    coo.md                     # Chief Operating Officer specialist
    cmo.md                     # Chief Marketing Officer specialist
    client-intel.md            # Client intelligence specialist
    secondbrain.md             # Knowledge vault operations
    comms.md                   # Communications (email/Slack/Zoom)
    frontend-developer.md      # Frontend implementation
    ui-designer.md             # UI/UX design
    qa-expert.md               # Quality assurance
    slack-synthesizer.md       # Slack content -> knowledge base
  bin/
    agent-loop.sh              # Auto-restart wrapper with crash detection
    dispatch-to-session.sh     # Message router (supports claude/codex/gemini)
    discord-notify.sh          # Discord API poster (with chunking for long messages)
    discord-create-channel.sh  # Channel provisioner
    discord-react.sh           # Add/remove Discord reactions
    discord-plugin-guard.sh    # Guard against unauthorized Discord plugin use
    kill-project-session.sh    # Session terminator (all runtimes)
    list-project-sessions.sh   # Session lister (all runtimes)
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
    zoom-setup-instructions.md # Zoom MCP server setup
    outlook-setup-instructions.md  # Outlook MCP setup
    memory-wake-inject.sh      # Inject memory context on session wake
    memory-consolidate.sh      # Memory consolidation cron wrapper
    count-project-tokens.py    # Token usage tracker for status line
    council-research.sh        # Multi-LLM parallel research orchestrator
    codex-run.sh               # Codex CLI wrapper with Discord output
    compact-session.sh         # Force-compact a session's context
    audit-log.sh               # Append to structured audit log
    stop-cleanup-orphans.sh    # Clean up orphaned tmux sessions
    task-create.sh             # Create task in PostgreSQL task board
    task-update.sh             # Update task status
    task-list.sh               # List/filter tasks
  hooks/
    post-to-discord.sh         # Stop hook -- auto-post to Discord
    memory-on-stop.sh          # Stop hook -- extract session memory
    memory-on-compact.sh       # PostCompact hook -- extract memory on compaction
    context-report-on-stop.sh  # Stop hook -- context continuity report
    stop-cleanup-orphans.sh    # Stop hook -- orphan session cleanup
    notify-agent-done.sh       # Notification hook -- macOS alerts
  db/
    init.sql                   # Database schema (sessions, memory, tasks)
    init-workstation.sql       # Workstation-specific init
    consolidate.sh             # Memory consolidation from DB
    db-migrate.sh              # Run pending migrations
    migrate-from-lancedb.sh    # Migration from LanceDB to PostgreSQL
    migrations/
      001_create_tasks.sql     # Task board schema
  dashboard/
    server.js                  # Express dashboard on port 7777
    package.json
  channels/
    discord/
      .env                     # Bot token (gitignored)
      channel-map.json         # Channel-to-project mapping (gitignored)
      access.json              # Access control (gitignored)
    slack/
      config.json              # Slack bridge config (gitignored)
    zoom/
      config.json              # Zoom OAuth config (gitignored)
  mcp-servers/
    memory-server/             # Semantic memory MCP server
    slack-mcp/                 # Slack user MCP server
    zoom-transcript-mcp/       # Zoom transcript MCP server
  mcp-services/
    com.mcp.memory.plist       # LaunchAgent for memory MCP
    com.mcp.slack-user.plist   # LaunchAgent for Slack MCP
    com.mcp.zoom-transcripts.plist
    com.mcp.outlook-mcp.plist
    com.mcp.hass-mcp.plist
    com.mcp.google-calendar.plist
    com.mcp.ssh-manager.plist
    install-mcp-services.sh    # Install all LaunchAgents
    uninstall-mcp-services.sh  # Remove all LaunchAgents
  examples/
    CLAUDE.md.example          # Template for workspace CLAUDE.md
    HEARTBEAT.md.example       # Template for heartbeat checks
    settings.json              # Reference Claude Code settings
    standard-mcp.json          # Reference MCP server config
    discord-session-instructions.md  # How project sessions use Discord
    codex-session-instructions.md    # Instructions for Codex runtime
    gemini-session-instructions.md   # Instructions for Gemini runtime
  launchd/
    com.claude.agent.plist     # Auto-start on login
  jarvis-voice/                # Voice control interface (experimental)
```

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
| `DISCORD_CHANNEL_ID` | Current channel (set per-session by dispatch) | -- |
| `DISCORD_MESSAGE_ID` | Current message being processed | -- |
| `HEARTBEAT_FILE` | Path to HEARTBEAT.md | `$HOME/HEARTBEAT.md` |
| `SECOND_BRAIN_DIR` | Path to SecondBrain vault | `$HOME/SecondBrain` |

## Security Notes

- The bot token is stored in `~/.claude/channels/discord/.env` (gitignored)
- Zoom and Outlook credentials are in their respective config files (gitignored)
- Access is restricted via `access.json` allowlist -- only your Discord user ID can send commands
- `constitution.md` enforces immutable security rules across all sessions
- `discord-plugin-guard.sh` prevents unauthorized use of the Discord plugin from project sessions
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

**Database not running**: Run `docker compose -f docker-compose.yml up -d` from the repo root. Check with `docker ps | grep postgres`.

## License

MIT
