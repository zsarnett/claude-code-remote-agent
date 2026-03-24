/**
 * Tests for the decay scoring module.
 */

import { describe, it, expect } from "vitest";
import {
  calculateDecayScore,
  getDecayRate,
  applyDecayToResults,
} from "../src/decay.js";
import type { MemoryRecord, SearchResult } from "../src/types.js";

/** Helper to create a MemoryRecord with sensible defaults. */
function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: "test-id",
    text: "test memory",
    vector: [],
    source: "agent",
    source_path: "",
    category: "semantic",
    tags: "",
    importance: 0.5,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    file_hash: "",
    metadata: "{}",
    ...overrides,
  };
}

/** Helper to create a SearchResult. */
function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "test-id",
    text: "test memory",
    source: "agent",
    source_path: "",
    category: "semantic",
    tags: "",
    score: 0.8,
    importance: 0.5,
    created_at: Date.now(),
    metadata: "{}",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getDecayRate
// ---------------------------------------------------------------------------

describe("getDecayRate", () => {
  it("returns 0 for rules subtype in metadata", () => {
    const record = makeRecord({
      metadata: JSON.stringify({ subtype: "rule" }),
    });
    expect(getDecayRate(record)).toBe(0);
  });

  it("returns 0 for corrections subtype", () => {
    const record = makeRecord({
      metadata: JSON.stringify({ subtype: "correction" }),
    });
    expect(getDecayRate(record)).toBe(0);
  });

  it("returns 0.01 for preferences subtype", () => {
    const record = makeRecord({
      metadata: JSON.stringify({ subtype: "preference" }),
    });
    expect(getDecayRate(record)).toBe(0.01);
  });

  it("returns 5.0 for session_context subtype", () => {
    const record = makeRecord({
      metadata: JSON.stringify({ subtype: "session_context" }),
    });
    expect(getDecayRate(record)).toBe(5.0);
  });

  it("uses explicit decay_rate from metadata over subtype", () => {
    const record = makeRecord({
      metadata: JSON.stringify({ subtype: "rule", decay_rate: 0.3 }),
    });
    expect(getDecayRate(record)).toBe(0.3);
  });

  it("falls back to category default for semantic", () => {
    const record = makeRecord({ category: "semantic", metadata: "{}" });
    expect(getDecayRate(record)).toBe(0.05);
  });

  it("falls back to category default for episodic", () => {
    const record = makeRecord({ category: "episodic", metadata: "{}" });
    expect(getDecayRate(record)).toBe(0.1);
  });

  it("falls back to category default for procedural", () => {
    const record = makeRecord({ category: "procedural", metadata: "{}" });
    expect(getDecayRate(record)).toBe(0.02);
  });

  it("falls back to default 0.05 for unknown category", () => {
    const record = makeRecord({
      category: "unknown" as string,
      metadata: "{}",
    });
    expect(getDecayRate(record)).toBe(0.05);
  });

  it("handles invalid JSON metadata gracefully", () => {
    const record = makeRecord({
      category: "semantic",
      metadata: "not-json",
    });
    expect(getDecayRate(record)).toBe(0.05);
  });

  it("checks type field as fallback subtype source", () => {
    const record = makeRecord({
      metadata: JSON.stringify({ type: "pattern" }),
    });
    expect(getDecayRate(record)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// calculateDecayScore
// ---------------------------------------------------------------------------

describe("calculateDecayScore", () => {
  it("rules (decay_rate=0) never decay", () => {
    const now = Date.now();
    const longAgo = now - 365 * 24 * 60 * 60 * 1000; // 1 year ago

    const record = makeRecord({
      metadata: JSON.stringify({ subtype: "rule" }),
      importance: 0.8,
      access_count: 0,
      created_at: longAgo,
      last_accessed: longAgo,
    });

    const score = calculateDecayScore(record, now);
    // Should be importance * (1 + log(1)) = 0.8 * 1 = 0.8
    expect(score).toBeCloseTo(0.8, 2);
  });

  it("recent memories score higher than old memories", () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    const recentRecord = makeRecord({
      importance: 0.5,
      access_count: 0,
      created_at: oneHourAgo,
      last_accessed: oneHourAgo,
      category: "semantic",
      metadata: "{}",
    });

    const oldRecord = makeRecord({
      importance: 0.5,
      access_count: 0,
      created_at: oneMonthAgo,
      last_accessed: oneMonthAgo,
      category: "semantic",
      metadata: "{}",
    });

    const recentScore = calculateDecayScore(recentRecord, now);
    const oldScore = calculateDecayScore(oldRecord, now);

    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("high importance decays slower than low importance", () => {
    const now = Date.now();
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;

    const highImportance = makeRecord({
      importance: 0.9,
      access_count: 0,
      created_at: twoWeeksAgo,
      last_accessed: twoWeeksAgo,
      category: "semantic",
      metadata: "{}",
    });

    const lowImportance = makeRecord({
      importance: 0.2,
      access_count: 0,
      created_at: twoWeeksAgo,
      last_accessed: twoWeeksAgo,
      category: "semantic",
      metadata: "{}",
    });

    const highScore = calculateDecayScore(highImportance, now);
    const lowScore = calculateDecayScore(lowImportance, now);

    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("frequently accessed memories score higher", () => {
    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const accessed = makeRecord({
      importance: 0.5,
      access_count: 10,
      created_at: oneWeekAgo,
      last_accessed: oneWeekAgo,
      category: "semantic",
      metadata: "{}",
    });

    const notAccessed = makeRecord({
      importance: 0.5,
      access_count: 0,
      created_at: oneWeekAgo,
      last_accessed: oneWeekAgo,
      category: "semantic",
      metadata: "{}",
    });

    const accessedScore = calculateDecayScore(accessed, now);
    const notAccessedScore = calculateDecayScore(notAccessed, now);

    expect(accessedScore).toBeGreaterThan(notAccessedScore);
  });

  it("returns a value between 0 and 1", () => {
    const now = Date.now();
    const record = makeRecord({
      importance: 1.0,
      access_count: 100,
      created_at: now,
      last_accessed: now,
      category: "semantic",
      metadata: "{}",
    });

    const score = calculateDecayScore(record, now);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("session context decays fast", () => {
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    const sessionMemory = makeRecord({
      importance: 0.5,
      access_count: 0,
      created_at: twoDaysAgo,
      last_accessed: twoDaysAgo,
      metadata: JSON.stringify({ subtype: "session_context" }),
    });

    const semanticMemory = makeRecord({
      importance: 0.5,
      access_count: 0,
      created_at: twoDaysAgo,
      last_accessed: twoDaysAgo,
      category: "semantic",
      metadata: "{}",
    });

    const sessionScore = calculateDecayScore(sessionMemory, now);
    const semanticScore = calculateDecayScore(semanticMemory, now);

    // Session context should be much weaker after 2 days
    expect(sessionScore).toBeLessThan(semanticScore);
  });

  it("brand new memory has full strength", () => {
    const now = Date.now();
    const record = makeRecord({
      importance: 0.5,
      access_count: 0,
      created_at: now,
      last_accessed: now,
      category: "semantic",
      metadata: "{}",
    });

    const score = calculateDecayScore(record, now);
    // Should be close to importance * 1 * (1 + log(1)) = 0.5
    expect(score).toBeCloseTo(0.5, 1);
  });
});

// ---------------------------------------------------------------------------
// applyDecayToResults
// ---------------------------------------------------------------------------

describe("applyDecayToResults", () => {
  it("adjusts scores by decay strength", () => {
    const now = Date.now();
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    const recentRecord = makeRecord({
      id: "recent",
      importance: 0.5,
      created_at: now,
      last_accessed: now,
    });

    const oldRecord = makeRecord({
      id: "old",
      importance: 0.5,
      created_at: oneMonthAgo,
      last_accessed: oneMonthAgo,
    });

    const results: SearchResult[] = [
      makeResult({ id: "old", score: 0.9 }),
      makeResult({ id: "recent", score: 0.8 }),
    ];

    const adjusted = applyDecayToResults(results, [recentRecord, oldRecord], now);

    // Recent memory should have a higher adjusted score even though
    // its raw score was lower
    expect(adjusted[0].id).toBe("recent");
    expect(adjusted[1].id).toBe("old");
  });

  it("re-sorts results by adjusted score", () => {
    const now = Date.now();
    const records = [
      makeRecord({ id: "a", importance: 0.9, created_at: now, last_accessed: now }),
      makeRecord({
        id: "b",
        importance: 0.1,
        created_at: now - 60 * 24 * 60 * 60 * 1000,
        last_accessed: now - 60 * 24 * 60 * 60 * 1000,
      }),
    ];

    const results: SearchResult[] = [
      makeResult({ id: "b", score: 0.95 }),
      makeResult({ id: "a", score: 0.7 }),
    ];

    const adjusted = applyDecayToResults(results, records, now);

    // The "a" result should rank higher after decay adjustment
    expect(adjusted[0].id).toBe("a");
  });

  it("handles missing records gracefully", () => {
    const results: SearchResult[] = [
      makeResult({ id: "missing", score: 0.8 }),
    ];

    const adjusted = applyDecayToResults(results, [], Date.now());

    // Should return the result as-is with original score
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].score).toBe(0.8);
  });
});
