import { describe, it, expect } from "vitest";
import {
  extractObservations,
  splitSentences,
  getExtractionRuleNames,
} from "../src/extractor.js";

describe("extractor", () => {
  describe("splitSentences", () => {
    it("should split on periods", () => {
      const result = splitSentences(
        "First sentence here. Second sentence here."
      );
      expect(result).toEqual([
        "First sentence here.",
        "Second sentence here.",
      ]);
    });

    it("should split on newlines", () => {
      const result = splitSentences(
        "First sentence here\nSecond sentence here"
      );
      expect(result).toEqual([
        "First sentence here",
        "Second sentence here",
      ]);
    });

    it("should preserve abbreviations", () => {
      const result = splitSentences(
        "Use e.g. this pattern. Then do the next thing."
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toContain("e.g.");
    });

    it("should filter short fragments", () => {
      const result = splitSentences("OK. This is a longer sentence here.");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("This is a longer sentence here.");
    });
  });

  describe("extractObservations", () => {
    it("should extract decisions", () => {
      const text = "We decided to use LanceDB for vector storage.";
      const results = extractObservations(text);
      expect(results).toHaveLength(1);
      expect(results[0].rule).toBe("decision");
      expect(results[0].priority).toBe("red");
      expect(results[0].importance).toBe(0.9);
    });

    it("should extract blockers", () => {
      const text =
        "We are blocked on the API key from the vendor. Cannot proceed without it.";
      const results = extractObservations(text);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const blocker = results.find((r) => r.rule === "blocker");
      expect(blocker).toBeDefined();
      expect(blocker!.priority).toBe("red");
    });

    it("should extract preferences", () => {
      const text =
        "Zack prefers to always use Docker for database services.";
      const results = extractObservations(text);
      expect(results).toHaveLength(1);
      expect(results[0].rule).toBe("preference");
      expect(results[0].priority).toBe("yellow");
    });

    it("should extract learnings", () => {
      const text =
        "I learned that LanceDB needs at least one record to create a table.";
      const results = extractObservations(text);
      expect(results).toHaveLength(1);
      expect(results[0].rule).toBe("learning");
    });

    it("should extract architecture notes", () => {
      const text =
        "The architecture uses a hub-router pattern for session dispatch.";
      const results = extractObservations(text);
      expect(results).toHaveLength(1);
      expect(results[0].rule).toBe("architecture");
    });

    it("should extract TODOs", () => {
      const text = "TODO: Add rate limiting to the search endpoint.";
      const results = extractObservations(text);
      expect(results).toHaveLength(1);
      expect(results[0].rule).toBe("todo");
    });

    it("should extract patterns", () => {
      const text =
        "I keep seeing timeout errors when embedding large batches of text.";
      const results = extractObservations(text);
      expect(results).toHaveLength(1);
      expect(results[0].rule).toBe("pattern");
    });

    it("should extract completion notes", () => {
      const text = "Phase 1 is completed and deployed to production.";
      const results = extractObservations(text);
      expect(results).toHaveLength(1);
      expect(results[0].rule).toBe("completed");
      expect(results[0].priority).toBe("green");
    });

    it("should deduplicate same sentence matching multiple rules", () => {
      // "decided" matches decision rule, "pattern" matches pattern rule
      // Decision has higher importance, so it should win
      const text =
        "We decided on a new pattern for handling database connections.";
      const results = extractObservations(text);
      expect(results).toHaveLength(1);
      // Decision rule comes first in the ordered list, so it wins
      expect(results[0].rule).toBe("decision");
    });

    it("should extract multiple observations from multi-sentence text", () => {
      const text = [
        "We decided to use TypeScript strict mode.",
        "Found a bug in the auth module that needs fixing.",
        "The deployment is completed successfully.",
        "This paragraph has nothing interesting in it at all.",
      ].join(" ");
      const results = extractObservations(text);
      // Should match: decision, bug, completed (3 out of 4 sentences)
      expect(results).toHaveLength(3);
    });

    it("should return empty for text with no matches", () => {
      const text =
        "The weather is nice today and I had coffee for breakfast.";
      const results = extractObservations(text);
      expect(results).toHaveLength(0);
    });

    it("should handle empty text", () => {
      const results = extractObservations("");
      expect(results).toHaveLength(0);
    });
  });

  describe("getExtractionRuleNames", () => {
    it("should return all rule names", () => {
      const names = getExtractionRuleNames();
      expect(names).toContain("decision");
      expect(names).toContain("blocker");
      expect(names).toContain("preference");
      expect(names).toContain("learning");
      expect(names).toContain("architecture");
      expect(names).toContain("todo");
      expect(names).toContain("pattern");
      expect(names).toContain("completed");
      expect(names).toContain("bug");
      expect(names.length).toBe(9);
    });
  });
});
