/**
 * Memory MCP Server -- Entry point.
 * Registers all memory tools via the MCP SDK.
 * Uses stdio transport for communication with Claude Code.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { embed } from "./embedder.js";
import {
  connect,
  ensureTable,
  addRecords,
  tableExists,
} from "./db.js";
import { search } from "./search.js";
import { loadConfig } from "./config.js";
import { syncVault, getSyncManifest, clearManifest } from "./sync.js";
import { startWatcher, stopWatcher, isWatcherActive } from "./watcher.js";
import {
  checkpointToRecord,
  handoffToRecord,
  createCheckpointRecord,
  parseCheckpointMetadata,
} from "./checkpoint.js";
import {
  appendObservation,
  readObservations,
  filterObservations,
  getObservationsPath,
  pruneObservations,
} from "./observations.js";
import type { ObservationPriority } from "./observations.js";
import { extractObservations } from "./extractor.js";
import type { SearchProfile } from "./types.js";
import type { MemoryRecord } from "./types.js";
import type { Connection, Table } from "@lancedb/lancedb";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = loadConfig();

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

let dbConnection: Connection | null = null;
let memoriesTable: Table | null = null;

/**
 * Simple mutex for serializing table operations.
 * Prevents race conditions when multiple concurrent store calls
 * try to create or access the table simultaneously.
 */
let tableMutex: Promise<void> = Promise.resolve();

function withTableLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const prev = tableMutex;
  tableMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev.then(fn).finally(() => release());
}

/**
 * Get the memories table, opening the DB connection if needed.
 * Returns null if the table has not been created yet (no records stored).
 */
async function getTable(): Promise<Table | null> {
  return withTableLock(async () => {
    if (memoriesTable) {
      return memoriesTable;
    }

    if (!dbConnection) {
      dbConnection = await connect(config.dbPath);
    }

    const exists = await tableExists(dbConnection, config.tableName);
    if (!exists) {
      return null;
    }

    memoriesTable = await dbConnection.openTable(config.tableName);
    return memoriesTable;
  });
}

/**
 * Ensure the table exists (creating it with a record if needed) and return it.
 * Serialized by the table mutex to prevent race conditions.
 */
async function getOrCreateTableWithRecord(
  record: MemoryRecord
): Promise<Table> {
  return withTableLock(async () => {
    if (!dbConnection) {
      dbConnection = await connect(config.dbPath);
    }

    // Check if table already exists (may have been created by a previous call)
    const exists = await tableExists(dbConnection, config.tableName);
    if (exists) {
      if (!memoriesTable) {
        memoriesTable = await dbConnection.openTable(config.tableName);
      }
      await addRecords(memoriesTable, [record]);
      return memoriesTable;
    }

    // Create the table with this record
    memoriesTable = await ensureTable(dbConnection, config.tableName, record);
    return memoriesTable;
  });
}

/**
 * Get the DB connection, creating it if needed.
 */
async function getDb(): Promise<Connection> {
  if (!dbConnection) {
    dbConnection = await connect(config.dbPath);
  }
  return dbConnection;
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "memory",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: memory_search
// ---------------------------------------------------------------------------

server.tool(
  "memory_search",
  "Search semantic memory for relevant memories. Returns ranked results based on vector similarity. Supports context profiles: 'planning' (boosts strategic/decisions, wide time window), 'incident' (boosts blockers/errors, narrows to 48h), 'handoff' (boosts checkpoints/decisions, last 7 days), 'default' (no adjustments).",
  {
    query: z.string().describe("The search query text"),
    category: z
      .enum(["semantic", "episodic", "procedural", "relational"])
      .optional()
      .describe("Filter by memory category"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Filter by tags (must match all)"),
    source: z
      .enum(["vault", "agent"])
      .optional()
      .describe("Filter by memory source"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(10)
      .describe("Maximum number of results (default 10)"),
    profile: z
      .enum(["default", "planning", "incident", "handoff"])
      .optional()
      .default("default")
      .describe(
        "Context profile: planning (boost strategic context), incident (boost recent blockers/errors, 48h window), handoff (boost checkpoints/decisions, 7d window), default (no adjustments)"
      ),
  },
  async (args) => {
    try {
      const table = await getTable();

      if (!table) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                results: [],
                message: "Memory store is empty. No memories have been stored yet.",
              }),
            },
          ],
        };
      }

      const results = await search(table, {
        query: args.query,
        category: args.category,
        tags: args.tags,
        source: args.source,
        limit: args.limit,
        profile: args.profile as SearchProfile,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results, count: results.length }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_search] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, results: [] }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_store
// ---------------------------------------------------------------------------

server.tool(
  "memory_store",
  "Store a new memory in the semantic memory system. The memory will be embedded and indexed for future retrieval.",
  {
    content: z.string().describe("The memory content to store"),
    category: z
      .enum(["semantic", "episodic", "procedural", "relational"])
      .optional()
      .default("semantic")
      .describe("Memory category (default: semantic)"),
    tags: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Tags for the memory"),
    importance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.5)
      .describe("Importance score from 0 to 1 (default 0.5)"),
  },
  async (args) => {
    try {
      const now = Date.now();
      const vector = await embed(args.content);

      const record: MemoryRecord = {
        id: crypto.randomUUID(),
        text: args.content,
        vector,
        source: "agent",
        source_path: "",
        category: args.category,
        tags: args.tags.join(", "),
        importance: args.importance,
        access_count: 0,
        created_at: now,
        updated_at: now,
        last_accessed: now,
        file_hash: "",
        metadata: "{}",
      };

      const table = await getTable();

      if (table) {
        await addRecords(table, [record]);
      } else {
        await getOrCreateTableWithRecord(record);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              id: record.id,
              category: record.category,
              tags: record.tags,
              importance: record.importance,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_store] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, stored: false }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_get
// ---------------------------------------------------------------------------

server.tool(
  "memory_get",
  "Retrieve a specific memory by its ID.",
  {
    id: z.string().describe("The memory ID to retrieve"),
  },
  async (args) => {
    try {
      const table = await getTable();

      if (!table) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "not found" }),
            },
          ],
        };
      }

      const results = await table
        .query()
        .where(`id = '${args.id.replace(/'/g, "''")}'`)
        .toArray();

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "not found" }),
            },
          ],
        };
      }

      const memory = results[0] as unknown as MemoryRecord;
      // Strip the vector from the response to keep it concise
      const { vector, ...rest } = memory;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ memory: rest }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_get] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_update
// ---------------------------------------------------------------------------

server.tool(
  "memory_update",
  "Update an existing memory. Can modify content, category, tags, or importance. Re-embeds if content changes.",
  {
    id: z.string().describe("The ID of the memory to update"),
    content: z.string().optional().describe("New content text"),
    category: z
      .enum(["semantic", "episodic", "procedural", "relational"])
      .optional()
      .describe("New category"),
    tags: z.array(z.string()).optional().describe("New tags"),
    importance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("New importance score"),
  },
  async (args) => {
    try {
      const table = await getTable();

      if (!table) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "not found" }),
            },
          ],
        };
      }

      // Find the existing record
      const results = await table
        .query()
        .where(`id = '${args.id.replace(/'/g, "''")}'`)
        .toArray();

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "not found" }),
            },
          ],
        };
      }

      const existing = results[0] as unknown as MemoryRecord;
      const now = Date.now();

      // Build updated record
      const updatedText = args.content ?? existing.text;
      const needsReEmbed = args.content !== undefined && args.content !== existing.text;
      const updatedVector = needsReEmbed
        ? await embed(updatedText)
        : existing.vector;

      const updatedRecord: MemoryRecord = {
        ...existing,
        text: updatedText,
        vector: updatedVector,
        category: args.category ?? existing.category,
        tags: args.tags ? args.tags.join(", ") : existing.tags,
        importance: args.importance ?? existing.importance,
        updated_at: now,
      };

      // Delete old, insert new
      await table.delete(`id = '${args.id.replace(/'/g, "''")}'`);
      await addRecords(table, [updatedRecord]);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ updated: true, id: args.id }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_update] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, updated: false }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_delete
// ---------------------------------------------------------------------------

server.tool(
  "memory_delete",
  "Delete an agent memory by ID. Vault-sourced memories cannot be deleted (they are managed by vault sync).",
  {
    id: z.string().describe("The ID of the memory to delete"),
  },
  async (args) => {
    try {
      const table = await getTable();

      if (!table) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "not found" }),
            },
          ],
        };
      }

      // Find the record first to check its source
      const results = await table
        .query()
        .where(`id = '${args.id.replace(/'/g, "''")}'`)
        .toArray();

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "not found" }),
            },
          ],
        };
      }

      const record = results[0] as unknown as MemoryRecord;

      if (record.source !== "agent") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "Cannot delete vault-sourced memories. They are managed by vault sync.",
                deleted: false,
              }),
            },
          ],
        };
      }

      await table.delete(`id = '${args.id.replace(/'/g, "''")}'`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ deleted: true, id: args.id }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_delete] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, deleted: false }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_sync
// ---------------------------------------------------------------------------

server.tool(
  "memory_sync",
  "Trigger a vault sync. Scans configured vault directories for new, changed, or deleted markdown files and updates the index.",
  {
    full: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, clears the manifest and does a full re-index"),
  },
  async (args) => {
    try {
      if (config.vaultPaths.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "No vault paths configured. Set MEMORY_VAULT_PATHS.",
              }),
            },
          ],
        };
      }

      const db = await getDb();

      if (args.full) {
        await clearManifest(config.dbPath);
      }

      const stats = await syncVault(
        db,
        config.tableName,
        config.vaultPaths,
        config.excludePatterns
      );

      // Reset cached table reference since sync may have created/modified it
      memoriesTable = null;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(stats),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_sync] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_stats
// ---------------------------------------------------------------------------

server.tool(
  "memory_stats",
  "Get statistics and health info about the memory system: total memories, counts by source and category, last sync time, index size, embedding model, and system health.",
  {},
  async () => {
    try {
      // Check DB accessibility
      let dbAccessible = false;
      try {
        await getDb();
        dbAccessible = true;
      } catch {
        // DB not accessible
      }

      const table = await getTable();

      if (!table) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                total_memories: 0,
                vault_memories: 0,
                agent_memories: 0,
                by_category: {},
                last_sync: null,
                index_size_mb: 0,
                embedding_model: "Xenova/all-MiniLM-L6-v2",
                embedding_dimensions: 384,
                db_accessible: dbAccessible,
                last_consolidation: null,
                watcher_active: isWatcherActive(),
              }),
            },
          ],
        };
      }

      // Query all records (just id, source, category -- but LanceDB returns full rows)
      const allRecords = (await table.query().toArray()) as unknown as MemoryRecord[];

      const totalMemories = allRecords.length;
      const vaultMemories = allRecords.filter((r) => r.source === "vault").length;
      const agentMemories = allRecords.filter((r) => r.source === "agent").length;

      const byCategory: Record<string, number> = {};
      for (const record of allRecords) {
        const cat = record.category || "uncategorized";
        byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      }

      // Get last sync time from manifest
      const manifest = await getSyncManifest(config.dbPath);
      let lastSync: number | null = null;
      for (const entry of Object.values(manifest)) {
        if (entry.lastSync && (!lastSync || entry.lastSync > lastSync)) {
          lastSync = entry.lastSync;
        }
      }

      // Estimate index size
      let indexSizeMb = 0;
      try {
        const dbStat = await stat(config.dbPath);
        // For directories, walk the top-level files
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(config.dbPath);
        let totalBytes = 0;
        for (const file of files) {
          try {
            const fileStat = await stat(join(config.dbPath, file));
            if (fileStat.isFile()) {
              totalBytes += fileStat.size;
            }
          } catch {
            // skip inaccessible files
          }
        }
        indexSizeMb = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
      } catch {
        // DB path might not exist yet
      }

      // Get last consolidation timestamp from log
      let lastConsolidation: string | null = null;
      try {
        const consolidationLogPath = join(
          (await import("node:os")).homedir(),
          ".claude",
          "logs",
          "memory-consolidation.log"
        );
        const logContent = await readFile(consolidationLogPath, "utf-8");
        const lines = logContent.trim().split("\n");
        // Find the last "Consolidation finished" line
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].includes("Consolidation finished")) {
            // Extract the date from the log line format: [Mon Mar 23 ...] ...
            const dateMatch = lines[i].match(/^\[(.+?)\]/);
            if (dateMatch) {
              lastConsolidation = dateMatch[1];
            }
            break;
          }
        }
      } catch {
        // Log file may not exist yet
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              total_memories: totalMemories,
              vault_memories: vaultMemories,
              agent_memories: agentMemories,
              by_category: byCategory,
              last_sync: lastSync,
              index_size_mb: indexSizeMb,
              embedding_model: "Xenova/all-MiniLM-L6-v2",
              embedding_dimensions: 384,
              db_accessible: dbAccessible,
              last_consolidation: lastConsolidation,
              watcher_active: isWatcherActive(),
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_stats] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_checkpoint
// ---------------------------------------------------------------------------

server.tool(
  "memory_checkpoint",
  "Store a checkpoint of current work state. Captures what you are working on, blockers, recent decisions, and open questions. Use this periodically during long sessions to preserve context across compactions.",
  {
    working_on: z
      .string()
      .describe("What you are currently working on"),
    blockers: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Current blockers or stuck points"),
    recent_decisions: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Recent decisions made during this session"),
    open_questions: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Open questions that need answers"),
    session: z
      .string()
      .optional()
      .describe("Session name (e.g., hub, project-foo)"),
    cwd: z.string().optional().describe("Current working directory"),
  },
  async (args) => {
    try {
      const { text, metadata } = checkpointToRecord({
        working_on: args.working_on,
        blockers: args.blockers,
        recent_decisions: args.recent_decisions,
        open_questions: args.open_questions,
        session: args.session,
        cwd: args.cwd,
      });

      const record = await createCheckpointRecord(text, metadata, 0.85);

      const table = await getTable();
      if (table) {
        await addRecords(table, [record]);
      } else {
        await getOrCreateTableWithRecord(record);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              id: record.id,
              type: "checkpoint",
              session: args.session ?? null,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_checkpoint] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, stored: false }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_wake
// ---------------------------------------------------------------------------

server.tool(
  "memory_wake",
  "Retrieve the last checkpoint and high-importance recent memories. Call this when starting or resuming a session to recover context. Returns the most recent checkpoint plus important memories from a configurable time window.",
  {
    session: z
      .string()
      .optional()
      .describe(
        "Filter by session name. If omitted, returns the most recent checkpoint from any session."
      ),
    hours: z
      .number()
      .optional()
      .default(24)
      .describe(
        "Time window in hours for recent high-importance memories (default: 24)"
      ),
    min_importance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.7)
      .describe(
        "Minimum importance threshold for recent memories (default: 0.7)"
      ),
    include_observations: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include recent observations (default: true)"),
  },
  async (args) => {
    try {
      const table = await getTable();

      let lastCheckpoint: Record<string, unknown> | null = null;
      let lastHandoff: Record<string, unknown> | null = null;
      const recentMemories: Record<string, unknown>[] = [];

      if (table) {
        // Find the most recent checkpoint
        const allRecords = (await table
          .query()
          .toArray()) as unknown as MemoryRecord[];

        // Filter for checkpoints and handoffs
        const checkpoints = allRecords
          .filter((r) => {
            const meta = parseCheckpointMetadata(r);
            const isCheckpoint = meta.type === "checkpoint";
            if (args.session) {
              return isCheckpoint && meta.session === args.session;
            }
            return isCheckpoint;
          })
          .sort((a, b) => b.created_at - a.created_at);

        const handoffs = allRecords
          .filter((r) => {
            const meta = parseCheckpointMetadata(r);
            const isHandoff = meta.type === "handoff";
            if (args.session) {
              return isHandoff && meta.session === args.session;
            }
            return isHandoff;
          })
          .sort((a, b) => b.created_at - a.created_at);

        if (checkpoints.length > 0) {
          const cp = checkpoints[0];
          const meta = parseCheckpointMetadata(cp);
          const { vector, ...rest } = cp;
          lastCheckpoint = { ...rest, parsed_metadata: meta };
        }

        if (handoffs.length > 0) {
          const hf = handoffs[0];
          const meta = parseCheckpointMetadata(hf);
          const { vector, ...rest } = hf;
          lastHandoff = { ...rest, parsed_metadata: meta };
        }

        // Find high-importance recent memories
        const cutoff = Date.now() - args.hours * 60 * 60 * 1000;
        const recent = allRecords
          .filter((r) => {
            const meta = parseCheckpointMetadata(r);
            // Exclude checkpoints and handoffs from general memories list
            if (meta.type === "checkpoint" || meta.type === "handoff") {
              return false;
            }
            return (
              r.created_at >= cutoff && r.importance >= args.min_importance
            );
          })
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 10);

        for (const r of recent) {
          const { vector, ...rest } = r;
          recentMemories.push(rest);
        }
      }

      // Get recent observations if requested
      let observations: Record<string, unknown>[] = [];
      if (args.include_observations) {
        const allObs = await readObservations();
        const filtered = filterObservations(allObs, {
          sinceHours: args.hours,
        });
        // Sort: red first, then yellow, then green
        const priorityOrder: Record<string, number> = {
          red: 0,
          yellow: 1,
          green: 2,
        };
        filtered.sort(
          (a, b) =>
            (priorityOrder[a.priority] ?? 3) -
            (priorityOrder[b.priority] ?? 3)
        );
        observations = filtered;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              last_checkpoint: lastCheckpoint,
              last_handoff: lastHandoff,
              recent_memories: recentMemories,
              recent_observations: observations,
              wake_params: {
                session: args.session ?? null,
                hours: args.hours,
                min_importance: args.min_importance,
              },
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_wake] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_sleep
// ---------------------------------------------------------------------------

server.tool(
  "memory_sleep",
  "Store a handoff/sleep record before ending a session. Captures a summary of what was done, next steps, and unresolved blockers. This is the counterpart to memory_wake -- call sleep before session end so the next session can wake up with context.",
  {
    summary: z
      .string()
      .describe("Summary of what was accomplished in this session"),
    next_steps: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Next steps for whoever picks this up"),
    blockers: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Unresolved blockers"),
    session: z
      .string()
      .optional()
      .describe("Session name (e.g., hub, project-foo)"),
    cwd: z.string().optional().describe("Current working directory"),
  },
  async (args) => {
    try {
      const { text, metadata } = handoffToRecord({
        summary: args.summary,
        next_steps: args.next_steps,
        blockers: args.blockers,
        session: args.session,
        cwd: args.cwd,
      });

      const record = await createCheckpointRecord(text, metadata, 0.9);

      const table = await getTable();
      if (table) {
        await addRecords(table, [record]);
      } else {
        await getOrCreateTableWithRecord(record);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              id: record.id,
              type: "handoff",
              session: args.session ?? null,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_sleep] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, stored: false }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_observe
// ---------------------------------------------------------------------------

server.tool(
  "memory_observe",
  "Store a single-line observation with a priority tag. Observations are written to a flat markdown file (source of truth) and indexed in LanceDB for semantic search. Use this for quick notes, decisions, blockers, or patterns noticed during work.",
  {
    text: z.string().describe("The observation text (single line)"),
    priority: z
      .enum(["red", "yellow", "green"])
      .describe(
        "Priority: red = important/keep until resolved, yellow = moderate (~14 day decay), green = low priority (~7 day decay)"
      ),
    session: z
      .string()
      .optional()
      .describe("Session name for context"),
  },
  async (args) => {
    try {
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

      // Write to flat file (source of truth)
      await appendObservation({
        timestamp,
        priority: args.priority as ObservationPriority,
        text: args.text,
        session: args.session,
      });

      // Also index in LanceDB for semantic search
      const now = Date.now();
      const importanceMap: Record<string, number> = {
        red: 0.9,
        yellow: 0.6,
        green: 0.3,
      };
      const decayMap: Record<string, string> = {
        red: "permanent",
        yellow: "14d",
        green: "7d",
      };

      const vector = await embed(args.text);
      const record: MemoryRecord = {
        id: crypto.randomUUID(),
        text: args.text,
        vector,
        source: "agent",
        source_path: getObservationsPath(),
        category: "episodic",
        tags: `observation, ${args.priority}`,
        importance: importanceMap[args.priority] ?? 0.5,
        access_count: 0,
        created_at: now,
        updated_at: now,
        last_accessed: now,
        file_hash: "",
        metadata: JSON.stringify({
          type: "observation",
          priority: args.priority,
          decay: decayMap[args.priority],
          session: args.session ?? "",
          timestamp,
        }),
      };

      const table = await getTable();
      if (table) {
        await addRecords(table, [record]);
      } else {
        await getOrCreateTableWithRecord(record);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              id: record.id,
              priority: args.priority,
              file: getObservationsPath(),
              timestamp,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_observe] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, stored: false }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_extract
// ---------------------------------------------------------------------------

server.tool(
  "memory_extract",
  "Auto-extract observations from free text using rule-based pattern matching. Scans text for decisions, blockers, preferences, learnings, architecture notes, TODOs, patterns, and completions. Each extraction is stored as an observation with auto-assigned priority and importance. Use this after compaction summaries or session reviews to capture key points.",
  {
    text: z
      .string()
      .describe(
        "Free text to analyze (e.g., session summary, compaction summary, meeting notes)"
      ),
    session: z
      .string()
      .optional()
      .describe("Session name to tag extracted observations with"),
    dry_run: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, returns what would be extracted without storing anything"
      ),
  },
  async (args) => {
    try {
      const extracted = extractObservations(args.text);

      if (extracted.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                extracted: 0,
                observations: [],
                message: "No notable patterns found in the provided text.",
              }),
            },
          ],
        };
      }

      if (args.dry_run) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                dry_run: true,
                extracted: extracted.length,
                observations: extracted.map((e) => ({
                  text: e.text,
                  priority: e.priority,
                  importance: e.importance,
                  rule: e.rule,
                })),
              }),
            },
          ],
        };
      }

      // Store each extracted observation
      const storedIds: string[] = [];
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

      for (const obs of extracted) {
        // Write to flat file
        await appendObservation({
          timestamp,
          priority: obs.priority,
          text: obs.text,
          session: args.session,
        });

        // Index in LanceDB
        const now = Date.now();
        const decayMap: Record<string, string> = {
          red: "permanent",
          yellow: "14d",
          green: "7d",
        };

        const vector = await embed(obs.text);
        const record: MemoryRecord = {
          id: crypto.randomUUID(),
          text: obs.text,
          vector,
          source: "agent",
          source_path: getObservationsPath(),
          category: "episodic",
          tags: `observation, ${obs.priority}, extracted, ${obs.rule}`,
          importance: obs.importance,
          access_count: 0,
          created_at: now,
          updated_at: now,
          last_accessed: now,
          file_hash: "",
          metadata: JSON.stringify({
            type: "observation",
            priority: obs.priority,
            decay: decayMap[obs.priority],
            session: args.session ?? "",
            timestamp,
            extraction_rule: obs.rule,
          }),
        };

        const table = await getTable();
        if (table) {
          await addRecords(table, [record]);
        } else {
          await getOrCreateTableWithRecord(record);
        }

        storedIds.push(record.id);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              extracted: extracted.length,
              stored_ids: storedIds,
              observations: extracted.map((e) => ({
                text: e.text,
                priority: e.priority,
                importance: e.importance,
                rule: e.rule,
              })),
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_extract] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, extracted: 0 }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_prune_observations
// ---------------------------------------------------------------------------

server.tool(
  "memory_prune_observations",
  "Prune expired observations based on their priority decay thresholds. Red observations are never pruned (kept until manually resolved). Yellow observations are pruned after ~14 days. Green observations are pruned after ~7 days. Rewrites the observations file with only surviving entries.",
  {
    dry_run: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, reports what would be pruned without actually removing anything"),
  },
  async (args) => {
    try {
      if (args.dry_run) {
        // Simulate pruning without writing
        const allObs = await readObservations();
        const now = Date.now();
        const decayHours: Record<string, number | null> = {
          red: null,
          yellow: 14 * 24,
          green: 7 * 24,
        };
        let prunedCount = 0;
        const prunedTexts: string[] = [];

        for (const obs of allObs) {
          const maxAge = decayHours[obs.priority];
          if (maxAge === null) continue;

          const obsTime = new Date(obs.timestamp).getTime();
          const ageHours = (now - obsTime) / (1000 * 60 * 60);

          if (ageHours > maxAge) {
            prunedCount++;
            prunedTexts.push(`[${obs.priority}] ${obs.text}`);
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                dry_run: true,
                would_prune: prunedCount,
                would_keep: allObs.length - prunedCount,
                expired: prunedTexts,
              }),
            },
          ],
        };
      }

      const result = await pruneObservations();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              pruned: result.pruned,
              kept: result.kept,
              removed: result.prunedTexts,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_prune_observations] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_rebuild
// ---------------------------------------------------------------------------

server.tool(
  "memory_rebuild",
  "Rebuild the entire memory index from scratch. Clears the vector store and re-indexes all vault files. Use this to recover from index corruption. WARNING: Agent-generated memories will be lost.",
  {
    confirm: z.literal("yes").describe("Must pass 'yes' to confirm rebuild"),
  },
  async (args) => {
    try {
      const db = await getDb();
      const tableNames = await db.tableNames();

      if (tableNames.includes(config.tableName)) {
        await db.dropTable(config.tableName);
      }
      memoriesTable = null;

      // Clear manifest
      await clearManifest(config.dbPath);

      // Re-sync vaults
      if (config.vaultPaths.length > 0) {
        const stats = await syncVault(
          db,
          config.tableName,
          config.vaultPaths,
          config.excludePatterns
        );

        // Re-open the table after sync
        const exists = await tableExists(db, config.tableName);
        if (exists) {
          memoriesTable = await db.openTable(config.tableName);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ rebuilt: true, ...stats }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              rebuilt: true,
              message:
                "Index cleared. No vault paths configured for re-sync.",
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[memory_rebuild] Error: ${errorMessage}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: errorMessage, rebuilt: false }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.error("[memory-mcp] Starting Memory MCP Server v1.0.0...");
  console.error(`[memory-mcp] DB path: ${config.dbPath}`);
  console.error(`[memory-mcp] Table name: ${config.tableName}`);
  console.error(
    `[memory-mcp] Vault paths: ${config.vaultPaths.length > 0 ? config.vaultPaths.join(", ") : "(none)"}`
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[memory-mcp] Server connected and ready.");

  // Run initial vault sync in the background (don't block MCP connection)
  if (config.vaultPaths.length > 0) {
    (async () => {
      try {
        console.error("[memory-mcp] Starting initial vault sync...");
        const db = await getDb();

        const stats = await syncVault(
          db,
          config.tableName,
          config.vaultPaths,
          config.excludePatterns
        );

        console.error(
          `[memory-mcp] Initial sync complete: ${stats.total} files indexed in ${stats.duration_ms}ms.`
        );

        // Start file watcher after initial sync
        startWatcher(config, db, config.tableName);
      } catch (err) {
        console.error("[memory-mcp] Initial sync error:", err);
      }
    })();
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.error("[memory-mcp] Shutting down...");
  await stopWatcher();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.error("[memory-mcp] Shutting down...");
  await stopWatcher();
  process.exit(0);
});

main().catch((error) => {
  console.error("[memory-mcp] Fatal error:", error);
  process.exit(1);
});
