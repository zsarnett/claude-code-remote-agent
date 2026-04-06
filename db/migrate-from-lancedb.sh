#!/bin/bash
# One-time migration: copy existing LanceDB memory records to pgvector.
# Reads records from ~/.claude/memory-index/ and inserts into memory.facts.
#
# Usage: migrate-from-lancedb.sh [--dry-run]

set -euo pipefail

DRY_RUN="${1:-}"

node --experimental-vm-modules -e "
import * as lancedb from '@lancedb/lancedb';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const DB_PATH = join(homedir(), '.claude', 'memory-index');
const TABLE_NAME = 'memories';
const dryRun = '$DRY_RUN' === '--dry-run';

async function main() {
  const db = await lancedb.connect(DB_PATH);
  const names = await db.tableNames();

  if (!names.includes(TABLE_NAME)) {
    console.log('No memories table found in LanceDB. Nothing to migrate.');
    process.exit(0);
  }

  const table = await db.openTable(TABLE_NAME);
  const records = await table.query().toArray();
  console.log('Found ' + records.length + ' records in LanceDB.');

  let migrated = 0;
  let skipped = 0;

  for (const r of records) {
    const text = r.text || '';
    if (!text || text.length < 10) {
      skipped++;
      continue;
    }

    let meta = {};
    try { meta = JSON.parse(r.metadata || '{}'); } catch {}

    // Determine target tier
    const type = meta.type || '';
    const category = r.category || 'semantic';

    if (dryRun) {
      console.log('[dry-run] Would migrate: ' + text.substring(0, 80) + '...');
      migrated++;
      continue;
    }

    // Escape for SQL dollar quoting (replace any dollar-dollar sequences)
    const escaped = text.replace(/\\$\\$/g, '\\$ \\$');
    const session = (meta.session || '').replace(/\\$\\$/g, '\\$ \\$');

    if (type === 'checkpoint' || type === 'handoff' || category === 'episodic') {
      const sql = \`INSERT INTO memory.episodes (session_name, summary, outcome) VALUES ('\$\$\${session}\$\$', '\$\$\${escaped}\$\$', '\${type}')\`;
      try {
        execSync(\`docker exec -i workstation-postgres psql -U workstation -d workstation -q -c \"\${sql.replace(/\"/g, '\\\\\"')}\"\`, { stdio: 'pipe' });
        migrated++;
      } catch (e) {
        console.error('Failed to migrate episode: ' + e.message);
        skipped++;
      }
    } else {
      const factCat = type === 'observation' ? (meta.priority === 'red' ? 'correction' : 'domain') : 'domain';
      const sql = \`INSERT INTO memory.facts (content, category, source_session) VALUES ('\$\$\${escaped}\$\$', '\${factCat}', '\${session}')\`;
      try {
        execSync(\`docker exec -i workstation-postgres psql -U workstation -d workstation -q -c \"\${sql.replace(/\"/g, '\\\\\"')}\"\`, { stdio: 'pipe' });
        migrated++;
      } catch (e) {
        console.error('Failed to migrate fact: ' + e.message);
        skipped++;
      }
    }
  }

  console.log('Migration complete: ' + migrated + ' migrated, ' + skipped + ' skipped.');
}

main().catch(e => { console.error(e); process.exit(1); });
" 2>&1
