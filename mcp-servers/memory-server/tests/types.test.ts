/**
 * Tests for type definitions and constants.
 */

import { describe, it, expect } from "vitest";
import { VALID_CATEGORIES } from "../src/types.js";
import type {
  MemoryRecord,
  SearchOptions,
  SearchResult,
  Config,
  MemoryCategory,
} from "../src/types.js";

describe("types", () => {
  it("should export valid categories", () => {
    expect(VALID_CATEGORIES).toContain("semantic");
    expect(VALID_CATEGORIES).toContain("episodic");
    expect(VALID_CATEGORIES).toContain("procedural");
    expect(VALID_CATEGORIES).toContain("relational");
    expect(VALID_CATEGORIES).toHaveLength(4);
  });

  it("should allow constructing a valid MemoryRecord", () => {
    const record: MemoryRecord = {
      id: "test-uuid",
      text: "A test memory",
      vector: new Array(384).fill(0),
      source: "agent",
      source_path: "",
      category: "semantic",
      tags: "test, example",
      importance: 0.5,
      access_count: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      last_accessed: Date.now(),
      file_hash: "",
      metadata: "{}",
    };

    expect(record.id).toBe("test-uuid");
    expect(record.vector).toHaveLength(384);
    expect(record.source).toBe("agent");
  });

  it("should allow constructing SearchOptions with minimal fields", () => {
    const options: SearchOptions = {
      query: "find something",
    };
    expect(options.query).toBe("find something");
    expect(options.category).toBeUndefined();
    expect(options.limit).toBeUndefined();
  });

  it("should allow constructing SearchOptions with all fields", () => {
    const options: SearchOptions = {
      query: "find something",
      category: "episodic",
      tags: ["work", "meeting"],
      source: "vault",
      limit: 5,
    };
    expect(options.category).toBe("episodic");
    expect(options.tags).toHaveLength(2);
    expect(options.source).toBe("vault");
    expect(options.limit).toBe(5);
  });

  it("should allow constructing a SearchResult", () => {
    const result: SearchResult = {
      id: "result-uuid",
      text: "Found memory",
      source: "agent",
      source_path: "",
      category: "semantic",
      tags: "test",
      score: 0.95,
      importance: 0.7,
      created_at: Date.now(),
      metadata: "{}",
    };
    expect(result.score).toBe(0.95);
  });

  it("should allow constructing a Config", () => {
    const cfg: Config = {
      dbPath: "/tmp/test-db",
      vaultPaths: ["/path/one", "/path/two"],
      logPath: "/tmp/test.log",
      tableName: "memories",
    };
    expect(cfg.vaultPaths).toHaveLength(2);
    expect(cfg.tableName).toBe("memories");
  });

  it("should enforce category type at compile time", () => {
    const category: MemoryCategory = "procedural";
    expect(VALID_CATEGORIES).toContain(category);
  });
});
