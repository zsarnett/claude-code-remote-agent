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
  "Search semantic memory for relevant memories. Returns ranked results based on vector similarity to the query.",
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
