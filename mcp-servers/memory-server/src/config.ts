/**
 * Configuration management for the Memory MCP Server.
 * Loads settings from environment variables with sensible defaults.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.js";

const DEFAULT_EXCLUDE_PATTERNS =
  "node_modules,*.git,.DS_Store,*.png,*.jpg,*.jpeg,*.gif,*.svg,*.ico,*.pdf";

/**
 * Load configuration from environment variables.
 * Falls back to defaults for any unset variable.
 */
export function loadConfig(): Config {
  const dbPath =
    process.env.MEMORY_DB_PATH ?? join(homedir(), ".claude", "memory-index");

  const vaultPathsRaw = process.env.MEMORY_VAULT_PATHS ?? "";
  const vaultPaths = vaultPathsRaw
    ? vaultPathsRaw.split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  const logPath =
    process.env.MEMORY_LOG_PATH ??
    join(homedir(), ".claude", "logs", "memory-server.log");

  const excludeRaw =
    process.env.MEMORY_EXCLUDE_PATTERNS ?? DEFAULT_EXCLUDE_PATTERNS;
  const excludePatterns = excludeRaw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    dbPath,
    vaultPaths,
    logPath,
    tableName: "memories",
    excludePatterns,
  };
}
