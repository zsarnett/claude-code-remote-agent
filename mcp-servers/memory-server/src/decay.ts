/**
 * Time decay scoring for the Memory MCP Server.
 * Scores memories based on age, importance, access count, and memory type.
 *
 * Formula: effective_strength = importance * exp(-decayRate * idleHours / 168) * (1 + log(accessCount + 1))
 *
 * Decay rates by subtype (from metadata, with category-based fallbacks):
 * - Rules/corrections: 0.0 (never decay)
 * - Preferences: 0.01 (~16 months half-life)
 * - Decisions: 0.02 (~8 months half-life)
 * - Patterns: 0.5 (~2 weeks half-life)
 * - Session context: 5.0 (~1.4 days half-life)
 * - Default semantic: 0.05
 * - Default episodic: 0.1
 * - Default procedural: 0.02
 * - Default relational: 0.05
 */

import type { MemoryRecord, SearchResult } from "./types.js";

/** Hours in one week -- used as the time unit in the decay formula. */
const HOURS_PER_WEEK = 168;

/** Decay rates keyed by subtype (stored in metadata JSON). */
const SUBTYPE_DECAY_RATES: Record<string, number> = {
  rule: 0.0,
  rules: 0.0,
  correction: 0.0,
  corrections: 0.0,
  preference: 0.01,
  preferences: 0.01,
  decision: 0.02,
  decisions: 0.02,
  pattern: 0.5,
  patterns: 0.5,
  session_context: 5.0,
  session: 5.0,
  context: 5.0,
};

/** Fallback decay rates by category when no subtype is available. */
const CATEGORY_DECAY_RATES: Record<string, number> = {
  semantic: 0.05,
  episodic: 0.1,
  procedural: 0.02,
  relational: 0.05,
};

/** Default decay rate if neither subtype nor category match. */
const DEFAULT_DECAY_RATE = 0.05;

/**
 * Determine the decay rate for a memory record.
 * Checks metadata for a subtype or explicit decay_rate first,
 * then falls back to category-based defaults.
 */
export function getDecayRate(record: MemoryRecord): number {
  // Check metadata for explicit decay_rate or subtype
  if (record.metadata) {
    try {
      const meta = JSON.parse(record.metadata);

      // Explicit decay_rate in metadata takes priority
      if (typeof meta.decay_rate === "number") {
        return meta.decay_rate;
      }

      // Check subtype field
      if (typeof meta.subtype === "string") {
        const subtypeLower = meta.subtype.toLowerCase();
        if (subtypeLower in SUBTYPE_DECAY_RATES) {
          return SUBTYPE_DECAY_RATES[subtypeLower];
        }
      }

      // Check type field as fallback subtype source
      if (typeof meta.type === "string") {
        const typeLower = meta.type.toLowerCase();
        if (typeLower in SUBTYPE_DECAY_RATES) {
          return SUBTYPE_DECAY_RATES[typeLower];
        }
      }
    } catch {
      // Invalid JSON metadata -- fall through to category defaults
    }
  }

  // Fall back to category-based rate
  return CATEGORY_DECAY_RATES[record.category] ?? DEFAULT_DECAY_RATE;
}

/**
 * Calculate the decay strength for a memory record.
 * Returns a value between 0 and 1, where 1 is full strength and 0 is fully decayed.
 *
 * Formula: importance * exp(-decayRate * idleHours / 168) * (1 + log(accessCount + 1))
 *
 * The result is clamped to [0, 1].
 */
export function calculateDecayScore(
  record: MemoryRecord,
  now?: number
): number {
  const currentTime = now ?? Date.now();
  const decayRate = getDecayRate(record);

  // If decay rate is 0, this memory never decays
  if (decayRate === 0) {
    return Math.min(1, record.importance * (1 + Math.log(record.access_count + 1)));
  }

  // Calculate idle time in hours since last access (or creation if never accessed)
  const lastActive = Math.max(record.last_accessed, record.created_at);
  const idleMs = Math.max(0, currentTime - lastActive);
  const idleHours = idleMs / (1000 * 60 * 60);

  // Apply the decay formula
  const timeDecay = Math.exp(-decayRate * idleHours / HOURS_PER_WEEK);
  const accessBoost = 1 + Math.log(record.access_count + 1);
  const strength = record.importance * timeDecay * accessBoost;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, strength));
}

/**
 * Apply decay scoring to search results.
 * Multiplies each result's relevance score by its decay strength,
 * then re-sorts by the adjusted score in descending order.
 */
export function applyDecayToResults(
  results: SearchResult[],
  records: MemoryRecord[],
  now?: number
): SearchResult[] {
  // Build a lookup map from id -> MemoryRecord for decay calculation
  const recordMap = new Map<string, MemoryRecord>();
  for (const record of records) {
    recordMap.set(record.id, record);
  }

  const adjusted = results.map((result) => {
    const record = recordMap.get(result.id);
    if (!record) {
      // No matching record found -- return result as-is
      return result;
    }

    const decayStrength = calculateDecayScore(record, now);
    return {
      ...result,
      score: result.score * decayStrength,
    };
  });

  // Re-sort by adjusted score descending
  adjusted.sort((a, b) => b.score - a.score);

  return adjusted;
}
