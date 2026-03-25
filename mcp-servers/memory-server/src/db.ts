/**
 * LanceDB connection and table management.
 * Handles database initialization and table creation for memory storage.
 */

import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import type { Table } from "@lancedb/lancedb";
import type { MemoryRecord } from "./types.js";

let databaseConnection: lancedb.Connection | null = null;

/**
 * Connect to a LanceDB database at the given path.
 * Creates the directory if it does not exist.
 */
export async function connect(dbPath: string): Promise<lancedb.Connection> {
  if (databaseConnection) {
    return databaseConnection;
  }

  console.error(`[db] Connecting to LanceDB at ${dbPath}...`);
  databaseConnection = await lancedb.connect(dbPath);
  console.error(`[db] Connected successfully.`);

  return databaseConnection;
}

/**
 * Get an existing table or create it with the first record.
 * LanceDB requires at least one record to infer the schema when creating a table.
 */
export async function getOrCreateTable(
  db: lancedb.Connection,
  tableName: string
): Promise<Table> {
  const tableNames = await db.tableNames();

  if (tableNames.includes(tableName)) {
    console.error(`[db] Opening existing table "${tableName}".`);
    return db.openTable(tableName);
  }

  console.error(
    `[db] Table "${tableName}" does not exist. It will be created on first insert.`
  );

  // Return a proxy that creates the table on first use
  // We cannot create an empty table in LanceDB -- need at least one record
  return null as unknown as Table;
}

/**
 * Ensure the table exists by creating it with the given record if needed.
 * Returns the table handle.
 */
export async function ensureTable(
  db: lancedb.Connection,
  tableName: string,
  firstRecord: MemoryRecord
): Promise<Table> {
  const tableNames = await db.tableNames();

  if (tableNames.includes(tableName)) {
    return db.openTable(tableName);
  }

  console.error(`[db] Creating table "${tableName}" with initial record.`);
  const table = await db.createTable(
    tableName,
    [firstRecord as unknown as Record<string, unknown>]
  );
  return table;
}

/**
 * Add records to an existing table.
 */
export async function addRecords(
  table: Table,
  records: MemoryRecord[]
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  await table.add(records as unknown as Record<string, unknown>[]);
}

/**
 * Check if a table exists in the database.
 */
export async function tableExists(
  db: lancedb.Connection,
  tableName: string
): Promise<boolean> {
  const tableNames = await db.tableNames();
  return tableNames.includes(tableName);
}

/**
 * Ensure the FTS index exists on the text column.
 * Safe to call multiple times -- checks existing indices first.
 */
export async function ensureFtsIndex(table: Table): Promise<void> {
  try {
    const indices = await table.listIndices();
    const hasFts = indices.some(
      (idx) => idx.columns && idx.columns.includes("text")
    );
    if (hasFts) {
      return;
    }

    console.error("[db] Creating FTS index on 'text' column...");
    await table.createIndex("text", {
      config: Index.fts(),
    });
    console.error("[db] FTS index created.");
  } catch (err) {
    // FTS index creation may fail on very small tables or if already exists
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[db] FTS index creation skipped: ${msg}`);
  }
}

/**
 * Close the database connection and reset state.
 */
export function resetConnection(): void {
  databaseConnection = null;
}
