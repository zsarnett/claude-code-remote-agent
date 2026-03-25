#!/bin/bash
# Retrieve the last checkpoint/handoff for a session from the memory system.
# Outputs a context block that can be prepended to a dispatched message.
#
# Usage: memory-wake-inject.sh [session-name]
# Returns empty string if no checkpoint found or memory server unavailable.

SESSION_NAME="${1:-}"
MEMORY_SERVER="${HOME}/.claude/mcp-servers/memory-server/dist/index.js"

# If no memory server installed, exit silently
if [ ! -f "$MEMORY_SERVER" ]; then
  exit 0
fi

# Use a small Node script to query LanceDB directly (much faster than MCP roundtrip)
node --experimental-vm-modules -e "
import * as lancedb from '@lancedb/lancedb';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = process.env.MEMORY_DB_PATH ?? join(homedir(), '.claude', 'memory-index');
const TABLE_NAME = 'memories';

async function main() {
  try {
    const db = await lancedb.connect(DB_PATH);
    const names = await db.tableNames();
    if (!names.includes(TABLE_NAME)) {
      process.exit(0);
    }

    const table = await db.openTable(TABLE_NAME);
    const allRecords = await table.query().toArray();

    // Find checkpoints and handoffs
    const checkpoints = [];
    const handoffs = [];
    const observations = [];

    for (const r of allRecords) {
      let meta = {};
      try { meta = JSON.parse(r.metadata || '{}'); } catch {}

      const isTarget = !('${SESSION_NAME}') || meta.session === '${SESSION_NAME}' || meta.session === '';

      if (meta.type === 'checkpoint' && isTarget) {
        checkpoints.push({ record: r, meta });
      } else if (meta.type === 'handoff' && isTarget) {
        handoffs.push({ record: r, meta });
      } else if (meta.type === 'observation' && isTarget) {
        // Only recent observations (last 24h)
        const age = Date.now() - r.created_at;
        if (age < 24 * 60 * 60 * 1000) {
          observations.push({ record: r, meta });
        }
      }
    }

    // Sort by created_at descending
    checkpoints.sort((a, b) => b.record.created_at - a.record.created_at);
    handoffs.sort((a, b) => b.record.created_at - a.record.created_at);

    const parts = [];

    if (handoffs.length > 0) {
      const h = handoffs[0];
      parts.push('[LAST HANDOFF]');
      parts.push(h.record.text);
      const age = Math.round((Date.now() - h.record.created_at) / (1000 * 60 * 60));
      parts.push('(' + age + 'h ago)');
      parts.push('');
    }

    if (checkpoints.length > 0) {
      const c = checkpoints[0];
      parts.push('[LAST CHECKPOINT]');
      parts.push(c.record.text);
      const age = Math.round((Date.now() - c.record.created_at) / (1000 * 60 * 60));
      parts.push('(' + age + 'h ago)');
      parts.push('');
    }

    if (observations.length > 0) {
      parts.push('[RECENT OBSERVATIONS (' + observations.length + ')]');
      // Sort by priority: red first
      const priorityOrder = { red: 0, yellow: 1, green: 2 };
      observations.sort((a, b) => (priorityOrder[a.meta.priority] ?? 3) - (priorityOrder[b.meta.priority] ?? 3));
      for (const o of observations.slice(0, 5)) {
        parts.push('- [' + (o.meta.priority || '?') + '] ' + o.record.text);
      }
      parts.push('');
    }

    if (parts.length > 0) {
      console.log('--- Session Context (auto-injected from memory) ---');
      console.log(parts.join('\\n'));
      console.log('--- End Context ---');
    }
  } catch {
    // Memory system unavailable -- exit silently
    process.exit(0);
  }
}

main();
" 2>/dev/null
