/**
 * File watcher for vault directories.
 * Uses chokidar to watch for .md file changes and triggers
 * incremental sync operations.
 */

import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import type { Connection } from "@lancedb/lancedb";
import type { Config } from "./types.js";
import { syncSingleFile, removeSyncedFile } from "./sync.js";

let watcher: FSWatcher | null = null;

/** Debounce timers keyed by file path. */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const DEBOUNCE_MS = 300;

/**
 * Start watching vault directories for .md file changes.
 * On add/change, re-syncs the individual file.
 * On unlink, removes that file's records from the index.
 */
export function startWatcher(
  config: Config,
  db: Connection,
  tableName: string
): void {
  if (config.vaultPaths.length === 0) {
    console.error("[watcher] No vault paths configured, skipping file watcher.");
    return;
  }

  if (watcher) {
    console.error("[watcher] Watcher already running.");
    return;
  }

  const globPatterns = config.vaultPaths.map((p) => `${p}/**/*.md`);

  const ignored = config.excludePatterns.map((pattern) => {
    if (pattern.startsWith("*.")) {
      return `**/${pattern}`;
    }
    return `**/${pattern}/**`;
  });

  console.error(
    `[watcher] Starting file watcher on ${config.vaultPaths.length} vault path(s).`
  );

  watcher = chokidar.watch(globPatterns, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  const handleFileChange = (filePath: string) => {
    // Clear existing debounce timer for this file
    const existing = debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    debounceTimers.set(
      filePath,
      setTimeout(async () => {
        debounceTimers.delete(filePath);
        try {
          await syncSingleFile(db, tableName, filePath);
        } catch (err) {
          console.error(`[watcher] Error syncing file ${filePath}:`, err);
        }
      }, DEBOUNCE_MS)
    );
  };

  const handleFileDelete = (filePath: string) => {
    // Clear any pending sync for this file
    const existing = debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
      debounceTimers.delete(filePath);
    }

    setTimeout(async () => {
      try {
        await removeSyncedFile(db, tableName, filePath);
      } catch (err) {
        console.error(
          `[watcher] Error removing deleted file ${filePath}:`,
          err
        );
      }
    }, DEBOUNCE_MS);
  };

  watcher.on("add", handleFileChange);
  watcher.on("change", handleFileChange);
  watcher.on("unlink", handleFileDelete);

  watcher.on("error", (error) => {
    console.error("[watcher] Error:", error);
  });

  watcher.on("ready", () => {
    console.error("[watcher] File watcher ready and watching for changes.");
  });
}

/**
 * Check if the file watcher is currently active.
 */
export function isWatcherActive(): boolean {
  return watcher !== null;
}

/**
 * Stop the file watcher and clean up.
 */
export async function stopWatcher(): Promise<void> {
  if (!watcher) {
    return;
  }

  // Clear all pending debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  await watcher.close();
  watcher = null;
  console.error("[watcher] File watcher stopped.");
}
