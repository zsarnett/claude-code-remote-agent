/**
 * Core type definitions for the Memory MCP Server.
 */

/** A single memory record stored in LanceDB. */
export interface MemoryRecord {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Memory content text (FTS indexed) */
  text: string;
  /** 384-dimensional embedding vector from MiniLM */
  vector: number[];
  /** Origin of the memory: vault file or agent-generated */
  source: string;
  /** For vault sources: relative file path. Empty string for agent memories. */
  source_path: string;
  /** Semantic category of the memory */
  category: string;
  /** Comma-separated tag list */
  tags: string;
  /** Importance score from 0 to 1 */
  importance: number;
  /** Number of times this memory has been retrieved */
  access_count: number;
  /** Unix timestamp in milliseconds when memory was created */
  created_at: number;
  /** Unix timestamp in milliseconds when memory was last updated */
  updated_at: number;
  /** Unix timestamp in milliseconds when memory was last accessed via search */
  last_accessed: number;
  /** Content hash for vault-sourced memories (used for sync) */
  file_hash: string;
  /** Arbitrary metadata serialized as JSON string */
  metadata: string;
}

/** Options for searching memories. */
export interface SearchOptions {
  /** The search query text */
  query: string;
  /** Filter by category (semantic, episodic, procedural, relational) */
  category?: string;
  /** Filter by tags (records must contain all specified tags) */
  tags?: string[];
  /** Filter by source type */
  source?: "vault" | "agent";
  /** Maximum number of results to return */
  limit?: number;
}

/** A single search result returned to the caller. */
export interface SearchResult {
  /** Memory record ID */
  id: string;
  /** Memory content text */
  text: string;
  /** Source of the memory */
  source: string;
  /** Source file path (if vault) */
  source_path: string;
  /** Memory category */
  category: string;
  /** Comma-separated tags */
  tags: string;
  /** Relevance score (0-1, higher is more relevant) */
  score: number;
  /** Importance score */
  importance: number;
  /** When the memory was created */
  created_at: number;
  /** Arbitrary metadata */
  metadata: string;
}

/** Server configuration. */
export interface Config {
  /** Path to the LanceDB database directory */
  dbPath: string;
  /** Paths to vault directories for file sync */
  vaultPaths: string[];
  /** Path for log output */
  logPath: string;
  /** Name of the LanceDB table for memories */
  tableName: string;
  /** Glob patterns to exclude from vault sync */
  excludePatterns: string[];
}

/** Stats returned from a vault sync operation. */
export interface SyncStats {
  added: number;
  updated: number;
  removed: number;
  total: number;
  duration_ms: number;
}

/** Entry in the sync manifest tracking a single file. */
export interface ManifestEntry {
  hash: string;
  chunkIds: string[];
  lastSync: number;
}

/** The full sync manifest: filepath -> entry. */
export type SyncManifest = Record<string, ManifestEntry>;

/** Valid memory categories. */
export const VALID_CATEGORIES = [
  "semantic",
  "episodic",
  "procedural",
  "relational",
] as const;

export type MemoryCategory = (typeof VALID_CATEGORIES)[number];
