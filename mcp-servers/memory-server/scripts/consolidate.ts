/**
 * Background consolidation script for the Memory MCP Server.
 * Runs via cron (standalone, not part of the MCP server).
 *
 * Four passes:
 * 1. Decay -- archive memories with strength < 0.1 (no LLM)
 * 2. Dedup -- find near-duplicate agent memories and merge (uses claude -p)
 * 3. Consolidation -- synthesize related agent memories into insights (uses claude -p)
 * 4. Observation pruning -- remove expired green (>7d) and yellow (>14d) observations
 *
 * Usage:
 *   node dist/consolidate.js [--dry-run] [--verbose]
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { Table } from "@lancedb/lancedb";
import type { MemoryRecord } from "../src/types.js";
import { calculateDecayScore } from "../src/decay.js";
import { embed } from "../src/embedder.js";
import { pruneObservations } from "../src/observations.js";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH =
  process.env.MEMORY_DB_PATH ?? join(homedir(), ".claude", "memory-index");
const TABLE_NAME = "memories";
const CLAUDE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  process.stderr.write(`[consolidate] ${message}\n`);
}

function verbose(message: string): void {
  if (VERBOSE) {
    process.stderr.write(`[consolidate:verbose] ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// LLM helper
// ---------------------------------------------------------------------------

/**
 * Call claude -p with a prompt via stdin.
 * Returns the raw stdout response or null on error.
 */
function callClaude(prompt: string): string | null {
  try {
    const escaped = prompt.replace(/'/g, "'\\''");
    const result = execSync(
      `echo '${escaped}' | claude -p --model haiku`,
      {
        timeout: CLAUDE_TIMEOUT_MS,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    return result.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`claude -p call failed: ${message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async function openTable(
  db: lancedb.Connection
): Promise<Table | null> {
  const names = await db.tableNames();
  if (!names.includes(TABLE_NAME)) {
    log(`Table "${TABLE_NAME}" does not exist. Nothing to consolidate.`);
    return null;
  }
  return db.openTable(TABLE_NAME);
}

async function loadAllRecords(table: Table): Promise<MemoryRecord[]> {
  const rows = await table.query().toArray();
  return rows as unknown as MemoryRecord[];
}

async function deleteById(table: Table, id: string): Promise<void> {
  await table.delete(`id = '${id.replace(/'/g, "''")}'`);
}

async function addRecord(
  table: Table,
  record: MemoryRecord
): Promise<void> {
  await table.add([record as unknown as Record<string, unknown>]);
}

async function updateMetadata(
  table: Table,
  id: string,
  newMetadata: string
): Promise<void> {
  // LanceDB doesn't have great row-level updates, so we delete + re-insert
  const rows = await table
    .query()
    .where(`id = '${id.replace(/'/g, "''")}'`)
    .toArray();

  if (rows.length === 0) return;

  const record = rows[0] as unknown as MemoryRecord;
  await deleteById(table, id);
  await addRecord(table, { ...record, metadata: newMetadata });
}

// ---------------------------------------------------------------------------
// Pass 1: Decay
// ---------------------------------------------------------------------------

async function passDecay(table: Table): Promise<number> {
  log("Pass 1: Decay -- checking for memories below strength threshold...");

  const allRecords = await loadAllRecords(table);
  const now = Date.now();
  let archived = 0;

  for (const record of allRecords) {
    const strength = calculateDecayScore(record, now);
    verbose(`  ${record.id} | strength=${strength.toFixed(4)} | "${record.text.slice(0, 60)}..."`);

    if (strength < 0.1) {
      if (DRY_RUN) {
        log(`  [dry-run] Would archive: ${record.id} (strength=${strength.toFixed(4)})`);
      } else {
        await deleteById(table, record.id);
        verbose(`  Archived: ${record.id}`);
      }
      archived++;
    }
  }

  log(`Pass 1 complete: ${archived} memories ${DRY_RUN ? "would be" : ""} archived.`);
  return archived;
}

// ---------------------------------------------------------------------------
// Pass 2: Dedup
// ---------------------------------------------------------------------------

async function passDedup(table: Table): Promise<number> {
  log("Pass 2: Dedup -- finding near-duplicate agent memories...");

  const allRecords = await loadAllRecords(table);
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  // Filter to recent agent-generated memories
  const recentAgent = allRecords.filter(
    (r) => r.source === "agent" && r.created_at >= sevenDaysAgo
  );

  verbose(`  ${recentAgent.length} recent agent memories to check.`);

  if (recentAgent.length < 2) {
    log("Pass 2 complete: not enough recent agent memories for dedup.");
    return 0;
  }

  // Track which IDs have been deleted to avoid double-processing
  const deletedIds = new Set<string>();
  let mergeCount = 0;

  for (let i = 0; i < recentAgent.length; i++) {
    if (deletedIds.has(recentAgent[i].id)) continue;

    for (let j = i + 1; j < recentAgent.length; j++) {
      if (deletedIds.has(recentAgent[j].id)) continue;

      const similarity = cosineSimilarity(
        recentAgent[i].vector,
        recentAgent[j].vector
      );

      if (similarity > 0.85) {
        verbose(
          `  High similarity (${similarity.toFixed(3)}): "${recentAgent[i].text.slice(0, 40)}..." vs "${recentAgent[j].text.slice(0, 40)}..."`
        );

        // Ask claude to classify
        const prompt = `Classify these two memories as DUPLICATE, RELATED, or DISTINCT. Respond with ONLY one word.

Memory A: ${recentAgent[i].text}
Memory B: ${recentAgent[j].text}`;

        const classification = callClaude(prompt);

        if (classification && classification.toUpperCase().includes("DUPLICATE")) {
          // Keep the one with higher importance
          const keep =
            recentAgent[i].importance >= recentAgent[j].importance
              ? recentAgent[i]
              : recentAgent[j];
          const remove =
            keep === recentAgent[i] ? recentAgent[j] : recentAgent[i];

          if (DRY_RUN) {
            log(
              `  [dry-run] Would merge: keep ${keep.id}, delete ${remove.id}`
            );
          } else {
            await deleteById(table, remove.id);
            verbose(`  Merged: kept ${keep.id}, deleted ${remove.id}`);
          }

          deletedIds.add(remove.id);
          mergeCount++;
        } else {
          verbose(
            `  Classification: ${classification ?? "failed"} -- keeping both.`
          );
        }
      }
    }
  }

  log(`Pass 2 complete: ${mergeCount} duplicates ${DRY_RUN ? "would be" : ""} merged.`);
  return mergeCount;
}

// ---------------------------------------------------------------------------
// Pass 3: Consolidation
// ---------------------------------------------------------------------------

async function passConsolidate(table: Table): Promise<number> {
  log("Pass 3: Consolidation -- synthesizing agent memories...");

  const allRecords = await loadAllRecords(table);

  // Filter to unconsolidated agent memories
  const unconsolidated = allRecords.filter((r) => {
    if (r.source !== "agent") return false;

    try {
      const meta = JSON.parse(r.metadata);
      // Skip if already consolidated
      if (meta.consolidated_at) return false;
      // Skip if this is itself a consolidation result
      if (meta.is_consolidation) return false;
    } catch {
      // No valid metadata -- include it
    }

    return true;
  });

  verbose(`  ${unconsolidated.length} unconsolidated agent memories found.`);

  if (unconsolidated.length < 3) {
    log("Pass 3 complete: fewer than 3 unconsolidated memories, skipping.");
    return 0;
  }

  // Take up to 20
  const batch = unconsolidated.slice(0, 20);

  // Format memories for the prompt
  const formatted = batch
    .map((r, i) => `${i + 1}. [${r.category}] ${r.text}`)
    .join("\n");

  const prompt = `Review these memories and produce a JSON response with:
1. "summary": A concise synthesis capturing all key facts
2. "insight": One cross-cutting pattern or observation
3. "tags": Relevant tags as an array

Memories:
${formatted}`;

  const response = callClaude(prompt);

  if (!response) {
    log("Pass 3 complete: claude -p call failed.");
    return 0;
  }

  // Parse the JSON response
  let parsed: { summary?: string; insight?: string; tags?: string[] };
  try {
    // Try to extract JSON from the response (claude might wrap it in markdown)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log("Pass 3 complete: could not extract JSON from claude response.");
      verbose(`  Response: ${response}`);
      return 0;
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    log(`Pass 3 complete: failed to parse claude response as JSON.`);
    verbose(`  Response: ${response}`);
    return 0;
  }

  if (!parsed.summary) {
    log("Pass 3 complete: claude response missing 'summary' field.");
    return 0;
  }

  const synthesisText = `${parsed.summary}${parsed.insight ? `\n\nInsight: ${parsed.insight}` : ""}`;
  const synthesisId = crypto.randomUUID();
  const now = Date.now();

  if (DRY_RUN) {
    log(`  [dry-run] Would create consolidation memory: "${synthesisText.slice(0, 80)}..."`);
    log(`  [dry-run] Would mark ${batch.length} memories as consolidated.`);
    return 1;
  }

  // Generate embedding for the synthesis
  const vector = await embed(synthesisText);

  const consolidationRecord: MemoryRecord = {
    id: synthesisId,
    text: synthesisText,
    vector,
    source: "agent",
    source_path: "",
    category: "semantic",
    tags: (parsed.tags ?? []).join(", "),
    importance: 0.7,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    file_hash: "",
    metadata: JSON.stringify({
      is_consolidation: true,
      source_memory_ids: batch.map((r) => r.id),
      consolidated_count: batch.length,
    }),
  };

  await addRecord(table, consolidationRecord);
  verbose(`  Created consolidation memory: ${synthesisId}`);

  // Mark source memories as consolidated
  for (const record of batch) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(record.metadata);
    } catch {
      // start fresh
    }
    meta.consolidated_at = now;
    await updateMetadata(table, record.id, JSON.stringify(meta));
  }

  log(`Pass 3 complete: synthesized ${batch.length} memories into 1 consolidation.`);
  return 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting consolidation${DRY_RUN ? " (dry run)" : ""}...`);
  log(`DB path: ${DB_PATH}`);

  const db = await lancedb.connect(DB_PATH);
  const table = await openTable(db);

  if (!table) {
    log("No table found. Exiting.");
    process.exit(0);
  }

  const decayArchived = await passDecay(table);
  const dedupMerged = await passDedup(table);
  const consolidations = await passConsolidate(table);

  // Pass 4: Observation pruning (no LLM needed)
  log("Pass 4: Observation pruning -- removing expired observations...");
  let observationsPruned = 0;
  if (DRY_RUN) {
    // Import and check what would be pruned without actually doing it
    const { readObservations, filterObservations } = await import("../src/observations.js");
    const allObs = await readObservations();
    const now = Date.now();
    const decayHours: Record<string, number | null> = { red: null, yellow: 14 * 24, green: 7 * 24 };
    for (const obs of allObs) {
      const maxAge = decayHours[obs.priority];
      if (maxAge === null) continue;
      const obsTime = new Date(obs.timestamp).getTime();
      const ageHours = (now - obsTime) / (1000 * 60 * 60);
      if (ageHours > maxAge) {
        log(`  [dry-run] Would prune: [${obs.priority}] ${obs.text}`);
        observationsPruned++;
      }
    }
  } else {
    const result = await pruneObservations();
    observationsPruned = result.pruned;
    if (result.pruned > 0) {
      for (const text of result.prunedTexts) {
        verbose(`  Pruned: ${text}`);
      }
    }
  }
  log(`Pass 4 complete: ${observationsPruned} observations ${DRY_RUN ? "would be" : ""} pruned.`);

  log("--- Summary ---");
  log(`  Decayed/archived: ${decayArchived}`);
  log(`  Duplicates merged: ${dedupMerged}`);
  log(`  Consolidations created: ${consolidations}`);
  log(`  Observations pruned: ${observationsPruned}`);
  log("Done.");
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
