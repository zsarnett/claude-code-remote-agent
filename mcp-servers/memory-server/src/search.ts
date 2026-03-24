/**
 * Search implementation for the Memory MCP Server.
 * Vector search with post-retrieval filtering and time-decay scoring.
 */

import type { Table } from "@lancedb/lancedb";
import type { SearchOptions, SearchResult, MemoryRecord } from "./types.js";
import { embed } from "./embedder.js";
import { applyDecayToResults } from "./decay.js";

/**
 * Perform a vector similarity search against the memories table.
 * Returns the top results ranked by cosine similarity.
 */
export async function vectorSearch(
  table: Table,
  queryVector: number[],
  limit: number
): Promise<MemoryRecord[]> {
  const results = await table
    .search(queryVector)
    .limit(limit)
    .toArray();

  return results as unknown as MemoryRecord[];
}

/**
 * Apply post-retrieval filters to search results.
 * Filters by category, tags, and source if specified.
 */
function applyFilters(
  records: MemoryRecord[],
  options: SearchOptions
): MemoryRecord[] {
  let filtered = records;

  if (options.category) {
    filtered = filtered.filter(
      (record) => record.category === options.category
    );
  }

  if (options.source) {
    filtered = filtered.filter((record) => record.source === options.source);
  }

  if (options.tags && options.tags.length > 0) {
    filtered = filtered.filter((record) => {
      const recordTags = record.tags
        .split(",")
        .map((tag) => tag.trim().toLowerCase());
      return options.tags!.every((searchTag) =>
        recordTags.includes(searchTag.toLowerCase())
      );
    });
  }

  return filtered;
}

/**
 * Convert a raw MemoryRecord (with LanceDB distance score) into a SearchResult.
 * LanceDB returns a _distance field for vector search results.
 */
function toSearchResult(
  record: MemoryRecord & { _distance?: number }
): SearchResult {
  // LanceDB _distance is L2 distance; convert to a 0-1 similarity score.
  // Lower distance = higher similarity.
  const distance = record._distance ?? 0;
  const score = 1 / (1 + distance);

  return {
    id: record.id,
    text: record.text,
    source: record.source,
    source_path: record.source_path,
    category: record.category,
    tags: record.tags,
    score,
    importance: record.importance,
    created_at: record.created_at,
    metadata: record.metadata,
  };
}

/**
 * Main search function. Embeds the query, performs vector search,
 * applies filters, applies decay scoring, and returns scored results.
 */
export async function search(
  table: Table,
  options: SearchOptions
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;

  // Fetch more than needed to account for post-retrieval filtering
  const fetchLimit = limit * 3;

  const queryVector = await embed(options.query);
  const rawResults = await vectorSearch(table, queryVector, fetchLimit);
  const filtered = applyFilters(rawResults, options);
  const scored = filtered.map(toSearchResult);

  // Apply decay scoring: multiply relevance by decay strength, re-sort
  const decayAdjusted = applyDecayToResults(scored, filtered);

  // Take the requested limit
  return decayAdjusted.slice(0, limit);
}
