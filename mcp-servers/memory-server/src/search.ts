/**
 * Search implementation for the Memory MCP Server.
 * Hybrid search: vector similarity + BM25 full-text search with RRF reranking.
 * Also supports post-retrieval filtering, time-decay scoring,
 * and context profiles for different retrieval strategies.
 */

import type { Table } from "@lancedb/lancedb";
import { rerankers } from "@lancedb/lancedb";
import type {
  SearchOptions,
  SearchResult,
  MemoryRecord,
  SearchProfile,
} from "./types.js";
import { embed } from "./embedder.js";
import { applyDecayToResults } from "./decay.js";

/**
 * Profile configuration: adjusts search behavior per context mode.
 */
interface ProfileConfig {
  /** Multiplier for the fetch limit (how many extra candidates to retrieve) */
  fetchMultiplier: number;
  /** Maximum age in hours for time-based filtering (null = no limit) */
  maxAgeHours: number | null;
  /** Categories to boost (their results get score multiplied by boostFactor) */
  boostCategories: string[];
  /** Tags to boost */
  boostTags: string[];
  /** Metadata types to boost */
  boostMetadataTypes: string[];
  /** Score multiplier for boosted results */
  boostFactor: number;
}

const PROFILE_CONFIGS: Record<SearchProfile, ProfileConfig> = {
  default: {
    fetchMultiplier: 3,
    maxAgeHours: null,
    boostCategories: [],
    boostTags: [],
    boostMetadataTypes: [],
    boostFactor: 1.0,
  },
  planning: {
    fetchMultiplier: 4,
    maxAgeHours: null, // Widen time window -- strategic context is timeless
    boostCategories: ["semantic", "procedural"],
    boostTags: ["decision", "architecture", "preference"],
    boostMetadataTypes: ["decision", "preference", "checkpoint"],
    boostFactor: 1.5,
  },
  incident: {
    fetchMultiplier: 5,
    maxAgeHours: 48, // Narrow to recent -- incidents need fresh context
    boostCategories: ["episodic"],
    boostTags: ["blocker", "bug", "red", "observation"],
    boostMetadataTypes: ["observation", "checkpoint"],
    boostFactor: 1.8,
  },
  handoff: {
    fetchMultiplier: 4,
    maxAgeHours: 168, // Last 7 days
    boostCategories: ["episodic", "procedural"],
    boostTags: ["checkpoint", "handoff", "decision"],
    boostMetadataTypes: ["checkpoint", "handoff", "decision"],
    boostFactor: 1.6,
  },
};

/** Track whether FTS is available for this table. */
let ftsAvailable: boolean | null = null;

/**
 * Check if the table has an FTS index on the text column.
 */
async function checkFtsAvailable(table: Table): Promise<boolean> {
  if (ftsAvailable !== null) return ftsAvailable;

  try {
    const indices = await table.listIndices();
    ftsAvailable = indices.some(
      (idx) => idx.columns && idx.columns.includes("text")
    );
  } catch {
    ftsAvailable = false;
  }

  return ftsAvailable;
}

/**
 * Reset the FTS availability cache (call after index creation or table changes).
 */
export function resetFtsCache(): void {
  ftsAvailable = null;
}

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
 * Perform a hybrid search: vector similarity + BM25 full-text search,
 * fused with Reciprocal Rank Fusion (RRF).
 *
 * Falls back to vector-only search if FTS index is not available.
 */
export async function hybridSearch(
  table: Table,
  query: string,
  queryVector: number[],
  limit: number
): Promise<MemoryRecord[]> {
  const hasFts = await checkFtsAvailable(table);

  if (!hasFts) {
    // Fallback to vector-only search
    return vectorSearch(table, queryVector, limit);
  }

  try {
    const reranker = await rerankers.RRFReranker.create();

    const results = await table
      .search(queryVector)
      .fullTextSearch(query, { columns: ["text"] })
      .rerank(reranker)
      .limit(limit)
      .toArray();

    return results as unknown as MemoryRecord[];
  } catch (err) {
    // If hybrid search fails for any reason, fall back to vector-only
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[search] Hybrid search failed, falling back to vector-only: ${msg}`);
    return vectorSearch(table, queryVector, limit);
  }
}

/**
 * Apply post-retrieval filters to search results.
 * Filters by category, tags, source, and profile-based time window.
 */
function applyFilters(
  records: MemoryRecord[],
  options: SearchOptions,
  profileConfig: ProfileConfig
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

  // Profile-based time window filter
  if (profileConfig.maxAgeHours !== null) {
    const cutoff =
      Date.now() - profileConfig.maxAgeHours * 60 * 60 * 1000;
    filtered = filtered.filter((record) => record.created_at >= cutoff);
  }

  return filtered;
}

/**
 * Apply profile-based score boosting to results.
 * Boosts results that match the profile's preferred categories, tags, or metadata types.
 */
function applyProfileBoost(
  results: SearchResult[],
  records: MemoryRecord[],
  profileConfig: ProfileConfig
): SearchResult[] {
  if (profileConfig.boostFactor <= 1.0) {
    return results;
  }

  const recordMap = new Map<string, MemoryRecord>();
  for (const record of records) {
    recordMap.set(record.id, record);
  }

  return results.map((result) => {
    const record = recordMap.get(result.id);
    if (!record) return result;

    let shouldBoost = false;

    // Check category boost
    if (profileConfig.boostCategories.includes(record.category)) {
      shouldBoost = true;
    }

    // Check tag boost
    if (!shouldBoost) {
      const recordTags = record.tags
        .split(",")
        .map((t) => t.trim().toLowerCase());
      if (
        profileConfig.boostTags.some((bt) =>
          recordTags.includes(bt.toLowerCase())
        )
      ) {
        shouldBoost = true;
      }
    }

    // Check metadata type boost
    if (!shouldBoost && record.metadata) {
      try {
        const meta = JSON.parse(record.metadata);
        if (
          typeof meta.type === "string" &&
          profileConfig.boostMetadataTypes.includes(meta.type.toLowerCase())
        ) {
          shouldBoost = true;
        }
      } catch {
        // Invalid metadata -- skip
      }
    }

    if (shouldBoost) {
      return { ...result, score: result.score * profileConfig.boostFactor };
    }
    return result;
  });
}

/**
 * Convert a raw MemoryRecord (with LanceDB distance/relevance score) into a SearchResult.
 * LanceDB returns _distance for vector search and _relevance_score for hybrid/FTS.
 */
function toSearchResult(
  record: MemoryRecord & { _distance?: number; _relevance_score?: number }
): SearchResult {
  let score: number;

  if (record._relevance_score !== undefined) {
    // Hybrid/RRF search returns a relevance score (higher = better)
    score = record._relevance_score;
  } else {
    // Vector-only: LanceDB _distance is L2 distance; convert to 0-1 similarity
    const distance = record._distance ?? 0;
    score = 1 / (1 + distance);
  }

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
 * Main search function. Embeds the query, performs hybrid search (vector + BM25),
 * applies filters, applies profile boosting, applies decay scoring,
 * and returns scored results.
 */
export async function search(
  table: Table,
  options: SearchOptions
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const profile = options.profile ?? "default";
  const profileConfig = PROFILE_CONFIGS[profile];

  // Fetch more than needed to account for post-retrieval filtering
  const fetchLimit = limit * profileConfig.fetchMultiplier;

  const queryVector = await embed(options.query);

  // Use hybrid search (vector + BM25 + RRF) when available
  const rawResults = await hybridSearch(
    table,
    options.query,
    queryVector,
    fetchLimit
  );

  const filtered = applyFilters(rawResults, options, profileConfig);
  const scored = filtered.map(toSearchResult);

  // Apply profile-based score boosting
  const boosted = applyProfileBoost(scored, filtered, profileConfig);

  // Apply decay scoring: multiply relevance by decay strength, re-sort
  const decayAdjusted = applyDecayToResults(boosted, filtered);

  // Take the requested limit
  return decayAdjusted.slice(0, limit);
}

/**
 * Get the profile configuration (exported for testing).
 */
export function getProfileConfig(profile: SearchProfile): ProfileConfig {
  return PROFILE_CONFIGS[profile];
}
