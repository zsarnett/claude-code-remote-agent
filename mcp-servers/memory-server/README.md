# Memory MCP Server

Persistent semantic memory for Claude Code. Uses LanceDB (embedded vector store) with local ONNX embeddings -- no cloud services, no API keys for embeddings.

## What it does

- **Semantic search** across memories using vector similarity + keyword matching
- **Auto-indexes** markdown vault files (SecondBrain, memory/ directory) with file watching
- **Time decay** on memories (old/unaccessed memories rank lower)
- **Background consolidation** via cron (dedup + synthesis using `claude -p --model haiku`)
- **8 MCP tools**: search, store, get, update, delete, sync, stats, rebuild

## Stack

- TypeScript MCP server (`@modelcontextprotocol/sdk`, stdio transport)
- LanceDB embedded vector store (zero config, automatic persistence)
- Local ONNX embeddings (`@huggingface/transformers`, Xenova/all-MiniLM-L6-v2, 384 dims)
- ~80MB model download on first run, cached locally thereafter
- ~200MB RAM footprint with model loaded

## Installation

The `install.sh` script in the repo root handles this automatically. It:
1. Runs `npm install` and `npm run build`
2. Copies the built server to `~/.claude/mcp-servers/memory-server/`
3. Installs the consolidation cron job (every 30 minutes)
4. Installs the PostCompact hook

## MCP Configuration

Add this to your workspace `.mcp.json` (adjust paths for your vault directories):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["~/.claude/mcp-servers/memory-server/dist/index.js"],
      "env": {
        "MEMORY_DB_PATH": "~/.claude/memory-index",
        "MEMORY_VAULT_PATHS": "~/.claude/memory,~/Documents/SecondBrain",
        "MEMORY_LOG_PATH": "~/.claude/logs/memory-server.log"
      }
    }
  }
}
```

Note: Replace `~` with your actual home directory path in the MCP config (MCP doesn't expand `~`).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB_PATH` | `~/.claude/memory-index` | LanceDB database directory |
| `MEMORY_VAULT_PATHS` | (none) | Comma-separated paths to index |
| `MEMORY_LOG_PATH` | `~/.claude/logs/memory-server.log` | Log file path |
| `MEMORY_EXCLUDE_PATTERNS` | `node_modules,*.git,...` | Glob patterns to skip |

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search with category/tags/source filters |
| `memory_store` | Store a new agent-generated memory |
| `memory_get` | Retrieve a specific memory by ID |
| `memory_update` | Update content, category, tags, or importance |
| `memory_delete` | Delete agent memories (vault memories are read-only) |
| `memory_sync` | Trigger incremental or full vault re-index |
| `memory_stats` | System stats and health info |
| `memory_rebuild` | Full index rebuild from scratch (recovery tool) |

## Background Consolidation

The consolidation script (`scripts/consolidate.sh`) runs every 30 minutes via cron:

1. **Idle check**: Skips if any Claude tmux session is active (< 5 min idle)
2. **Decay pass**: Archives memories with strength below threshold (no LLM)
3. **Dedup pass**: Finds near-duplicate memories, classifies via `claude -p --model haiku`
4. **Consolidation pass**: Synthesizes insights from related memories

Flags: `--dry-run` (preview only), `--verbose` (detailed logging)

## Development

```bash
cd mcp-servers/memory-server
npm install
npm run build    # Build to dist/
npm test         # Run tests
```

## How it works

1. Claude Code session starts, reads `.mcp.json`, spawns the memory server
2. Server loads the embedding model (first run downloads ~80MB, cached after)
3. Server syncs configured vault directories (incremental, hash-based)
4. File watcher monitors vault dirs for live changes
5. Agent uses `memory_search` and `memory_store` during conversations
6. Every 30 min (when idle), consolidation cron runs decay/dedup/synthesis
