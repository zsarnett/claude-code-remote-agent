import { describe, it, expect } from "vitest";
import {
  checkpointToRecord,
  handoffToRecord,
} from "../src/checkpoint.js";

describe("checkpoint", () => {
  describe("checkpointToRecord", () => {
    it("should convert checkpoint data to text and metadata", () => {
      const result = checkpointToRecord({
        working_on: "Building memory MCP server",
        blockers: ["LanceDB FTS API unclear"],
        recent_decisions: ["Use local embeddings", "Skip graph DB"],
        open_questions: ["How to handle concurrent writes?"],
        session: "memory-mcp",
        cwd: "/Users/test/project",
      });

      expect(result.text).toContain("Working on: Building memory MCP server");
      expect(result.text).toContain("Blockers: LanceDB FTS API unclear");
      expect(result.text).toContain("Decisions: Use local embeddings; Skip graph DB");
      expect(result.text).toContain("Open questions: How to handle concurrent writes?");

      expect(result.metadata.type).toBe("checkpoint");
      expect(result.metadata.session).toBe("memory-mcp");
      expect(result.metadata.cwd).toBe("/Users/test/project");
      expect(result.metadata.blockers).toEqual(["LanceDB FTS API unclear"]);
    });

    it("should handle empty arrays", () => {
      const result = checkpointToRecord({
        working_on: "Just working",
        blockers: [],
        recent_decisions: [],
        open_questions: [],
      });

      expect(result.text).toBe("Working on: Just working");
      expect(result.text).not.toContain("Blockers");
      expect(result.text).not.toContain("Decisions");
      expect(result.text).not.toContain("Open questions");
    });

    it("should default session and cwd to empty string", () => {
      const result = checkpointToRecord({
        working_on: "Something",
        blockers: [],
        recent_decisions: [],
        open_questions: [],
      });

      expect(result.metadata.session).toBe("");
      expect(result.metadata.cwd).toBe("");
    });
  });

  describe("handoffToRecord", () => {
    it("should convert handoff data to text and metadata", () => {
      const result = handoffToRecord({
        summary: "Completed Phase 1 of memory server",
        next_steps: ["Add vault sync", "Write tests"],
        blockers: ["Waiting for API keys"],
        session: "project-x",
      });

      expect(result.text).toContain("Summary: Completed Phase 1 of memory server");
      expect(result.text).toContain("Next steps: Add vault sync; Write tests");
      expect(result.text).toContain("Blockers: Waiting for API keys");

      expect(result.metadata.type).toBe("handoff");
      expect(result.metadata.session).toBe("project-x");
      expect(result.metadata.next_steps).toEqual(["Add vault sync", "Write tests"]);
    });

    it("should handle empty arrays", () => {
      const result = handoffToRecord({
        summary: "Done for now",
        next_steps: [],
        blockers: [],
      });

      expect(result.text).toBe("Summary: Done for now");
      expect(result.text).not.toContain("Next steps");
      expect(result.text).not.toContain("Blockers");
    });
  });
});
