/**
 * Vault sync engine for the Memory MCP Server.
 * Scans vault directories, detects changes via SHA-256 hashing,
 * and incrementally updates the LanceDB index.
 */

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import crypto from "node:crypto";
import type { Connection, Table } from "@lancedb/lancedb";

import type {
  MemoryRecord,
  SyncStats,
  SyncManifest,
  ManifestEntry,
} from "./types.js";
import { chunkMarkdown } from "./chunker.js";
import { embed } from "./embedder.js";
import { ensureTable, addRecords, tableExists } from "./db.js";

/**
 * Load the sync manifest from disk.
 * Returns an empty manifest if the file does not exist.
 */
export async function getSyncManifest(dbPath: string): Promise<SyncManifest> {
  const manifestPath = join(dbPath, "sync-manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as SyncManifest;
  } catch {
    return {};
  }
}

/**
 * Save the sync manifest to disk.
 */
async function saveSyncManifest(
  dbPath: string,
  manifest: SyncManifest
): Promise<void> {
  const manifestPath = join(dbPath, "sync-manifest.json");
  await mkdir(dbPath, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * Compute the SHA-256 hash of a string.
 */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Check if a file path matches any of the exclude patterns.
 * Supports simple glob patterns: exact match, leading *, and trailing *.
 */
function isExcluded(filePath: string, excludePatterns: string[]): boolean {
  for (const pattern of excludePatterns) {
    // Direct substring match (covers things like "node_modules", ".git")
    if (filePath.includes(pattern.replace(/^\*|\*$/g, ""))) {
      // For patterns like "*.png", check extension
      if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1); // ".png"
        if (filePath.endsWith(ext)) return true;
      } else if (pattern.startsWith("*")) {
        const suffix = pattern.slice(1);
        if (filePath.endsWith(suffix)) return true;
      } else if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        if (filePath.includes(prefix)) return true;
      } else {
        // Exact substring match -- covers "node_modules", ".DS_Store", ".git"
        if (filePath.includes(pattern)) return true;
      }
    }
  }
  return false;
}

/**
 * Recursively scan a directory for .md files, respecting exclude patterns.
 */
async function scanDirectory(
  dirPath: string,
  excludePatterns: string[]
): Promise<string[]> {
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    console.error(`[sync] Cannot read directory: ${dirPath}`);
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (isExcluded(fullPath, excludePatterns)) {
      continue;
    }

    if (entry.isDirectory()) {
      const nested = await scanDirectory(fullPath, excludePatterns);
      results.push(...nested);
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Process a single file: chunk, embed, and return records ready for insertion.
 */
async function processFile(
  filePath: string,
  content: string,
  contentHash: string
): Promise<{ records: MemoryRecord[]; chunkIds: string[] }> {
  const chunks = chunkMarkdown(content, filePath);
  const records: MemoryRecord[] = [];
  const chunkIds: string[] = [];
  const now = Date.now();

  for (const chunk of chunks) {
    const id = crypto.randomUUID();
    chunkIds.push(id);

    const vector = await embed(chunk.text);

    const record: MemoryRecord = {
      id,
      text: chunk.text,
      vector,
      source: "vault",
      source_path: filePath,
      category: chunk.metadata.type ?? "semantic",
      tags: chunk.metadata.tags ?? "",
      importance: 0.5,
      access_count: 0,
      created_at: now,
      updated_at: now,
      last_accessed: now,
      file_hash: contentHash,
      metadata: JSON.stringify(chunk.metadata),
    };

    records.push(record);
  }

  return { records, chunkIds };
}

/**
 * Sync vault directories with the LanceDB index.
 * Uses a hash-based manifest for incremental updates.
 *
 * Returns statistics about what was added, updated, and removed.
 */
export async function syncVault(
  db: Connection,
  tableName: string,
  vaultPaths: string[],
  excludePatterns: string[]
): Promise<SyncStats> {
  const startTime = Date.now();
  const stats: SyncStats = {
    added: 0,
    updated: 0,
    removed: 0,
    total: 0,
    duration_ms: 0,
  };

  // Derive dbPath from the connection URI for manifest storage.
  // We pass the db path via a convention: store manifest alongside the DB.
  // Since we cannot easily get the path from the Connection object,
  // we use process.env or a fallback.
  const dbPath =
    process.env.MEMORY_DB_PATH ??
    join(
      (await import("node:os")).homedir(),
      ".claude",
      "memory-index"
    );

  const manifest = await getSyncManifest(dbPath);
  const seenFiles = new Set<string>();

  // Scan all vault paths for .md files
  const allFiles: string[] = [];
  for (const vaultPath of vaultPaths) {
    const files = await scanDirectory(vaultPath, excludePatterns);
    allFiles.push(...files);
  }

  console.error(`[sync] Found ${allFiles.length} markdown files across ${vaultPaths.length} vault(s).`);

  // Get or open the table
  let table: Table | null = null;
  const tableNamesList = await db.tableNames();
  if (tableNamesList.includes(tableName)) {
    table = await db.openTable(tableName);
  }

  // Process each file
  for (const filePath of allFiles) {
    seenFiles.add(filePath);

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      console.error(`[sync] Cannot read file: ${filePath}`);
      continue;
    }

    const contentHash = sha256(content);
    const existing = manifest[filePath];

    // Skip if file has not changed
    if (existing && existing.hash === contentHash) {
      continue;
    }

    // If file changed, remove old records first
    if (existing && table) {
      try {
        await table.delete(`source_path = '${filePath.replace(/'/g, "''")}'`);
      } catch (err) {
        console.error(`[sync] Error deleting old records for ${filePath}:`, err);
      }
      stats.updated++;
    } else {
      stats.added++;
    }

    // Process and insert new records
    const { records, chunkIds } = await processFile(
      filePath,
      content,
      contentHash
    );

    if (records.length > 0) {
      if (!table) {
        // Create the table with the first record
        table = await ensureTable(db, tableName, records[0]);
        if (records.length > 1) {
          await addRecords(table, records.slice(1));
        }
      } else {
        await addRecords(table, records);
      }
    }

    // Update manifest
    manifest[filePath] = {
      hash: contentHash,
      chunkIds,
      lastSync: Date.now(),
    };
  }

  // Handle deleted files: files in manifest but no longer on disk
  for (const manifestPath of Object.keys(manifest)) {
    if (!seenFiles.has(manifestPath)) {
      if (table) {
        try {
          await table.delete(
            `source_path = '${manifestPath.replace(/'/g, "''")}'`
          );
        } catch (err) {
          console.error(
            `[sync] Error removing records for deleted file ${manifestPath}:`,
            err
          );
        }
      }
      delete manifest[manifestPath];
      stats.removed++;
    }
  }

  // Save updated manifest
  await saveSyncManifest(dbPath, manifest);

  // Count total indexed files
  stats.total = Object.keys(manifest).length;
  stats.duration_ms = Date.now() - startTime;

  console.error(
    `[sync] Sync complete: +${stats.added} added, ~${stats.updated} updated, -${stats.removed} removed, ${stats.total} total (${stats.duration_ms}ms)`
  );

  return stats;
}

/**
 * Sync a single file (used by the file watcher for incremental updates).
 */
export async function syncSingleFile(
  db: Connection,
  tableName: string,
  filePath: string
): Promise<void> {
  const dbPath =
    process.env.MEMORY_DB_PATH ??
    join(
      (await import("node:os")).homedir(),
      ".claude",
      "memory-index"
    );

  const manifest = await getSyncManifest(dbPath);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    console.error(`[sync] Cannot read file for single sync: ${filePath}`);
    return;
  }

  const contentHash = sha256(content);
  const existing = manifest[filePath];

  // Skip if unchanged
  if (existing && existing.hash === contentHash) {
    return;
  }

  // Open or create table
  let table: Table;
  const tableNamesList = await db.tableNames();
  if (tableNamesList.includes(tableName)) {
    table = await db.openTable(tableName);

    // Remove old records for this file
    if (existing) {
      try {
        await table.delete(`source_path = '${filePath.replace(/'/g, "''")}'`);
      } catch (err) {
        console.error(`[sync] Error deleting old records for ${filePath}:`, err);
      }
    }

    const { records, chunkIds } = await processFile(
      filePath,
      content,
      contentHash
    );

    if (records.length > 0) {
      await addRecords(table, records);
    }

    manifest[filePath] = {
      hash: contentHash,
      chunkIds,
      lastSync: Date.now(),
    };
  } else {
    // Table does not exist yet -- create it with first record
    const { records, chunkIds } = await processFile(
      filePath,
      content,
      contentHash
    );

    if (records.length > 0) {
      table = await ensureTable(db, tableName, records[0]);
      if (records.length > 1) {
        await addRecords(table, records.slice(1));
      }
    }

    manifest[filePath] = {
      hash: contentHash,
      chunkIds,
      lastSync: Date.now(),
    };
  }

  await saveSyncManifest(dbPath, manifest);
  console.error(`[sync] Single file synced: ${filePath}`);
}

/**
 * Remove a deleted file's records from the index.
 */
export async function removeSyncedFile(
  db: Connection,
  tableName: string,
  filePath: string
): Promise<void> {
  const dbPath =
    process.env.MEMORY_DB_PATH ??
    join(
      (await import("node:os")).homedir(),
      ".claude",
      "memory-index"
    );

  const manifest = await getSyncManifest(dbPath);

  const tableNamesList = await db.tableNames();
  if (tableNamesList.includes(tableName)) {
    const table = await db.openTable(tableName);
    try {
      await table.delete(`source_path = '${filePath.replace(/'/g, "''")}'`);
    } catch (err) {
      console.error(
        `[sync] Error removing records for deleted file ${filePath}:`,
        err
      );
    }
  }

  delete manifest[filePath];
  await saveSyncManifest(dbPath, manifest);
  console.error(`[sync] Removed file from index: ${filePath}`);
}

/**
 * Clear the sync manifest to force a full re-index on next sync.
 */
export async function clearManifest(dbPath: string): Promise<void> {
  await saveSyncManifest(dbPath, {});
  console.error("[sync] Manifest cleared -- next sync will be a full re-index.");
}
