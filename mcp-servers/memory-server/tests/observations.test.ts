import { describe, it, expect } from "vitest";
import {
  parseObservations,
  formatObservation,
  filterObservations,
} from "../src/observations.js";
import type { Observation } from "../src/observations.js";

describe("observations", () => {
  describe("parseObservations", () => {
    it("should parse a well-formed observation line", () => {
      const content =
        "# Observations\n\n- [2026-03-24T12:00:00Z] [red] Critical bug in auth module";
      const result = parseObservations(content);
      expect(result).toHaveLength(1);
      expect(result[0].timestamp).toBe("2026-03-24T12:00:00Z");
      expect(result[0].priority).toBe("red");
      expect(result[0].text).toBe("Critical bug in auth module");
      expect(result[0].session).toBeUndefined();
    });

    it("should parse observation with session tag", () => {
      const content =
        "- [2026-03-24T12:00:00Z] [yellow] Need to refactor database layer {session: hub}";
      const result = parseObservations(content);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("Need to refactor database layer");
      expect(result[0].session).toBe("hub");
    });

    it("should parse multiple observations", () => {
      const content = [
        "# Observations",
        "",
        "- [2026-03-24T12:00:00Z] [red] First observation",
        "- [2026-03-24T13:00:00Z] [green] Second observation",
        "- [2026-03-24T14:00:00Z] [yellow] Third observation {session: test}",
      ].join("\n");
      const result = parseObservations(content);
      expect(result).toHaveLength(3);
      expect(result[0].priority).toBe("red");
      expect(result[1].priority).toBe("green");
      expect(result[2].session).toBe("test");
    });

    it("should skip non-observation lines", () => {
      const content = [
        "# Observations",
        "",
        "Some random text",
        "- [2026-03-24T12:00:00Z] [red] Valid observation",
        "- This is not a valid observation",
        "",
      ].join("\n");
      const result = parseObservations(content);
      expect(result).toHaveLength(1);
    });

    it("should handle empty content", () => {
      const result = parseObservations("");
      expect(result).toHaveLength(0);
    });
  });

  describe("formatObservation", () => {
    it("should format observation without session", () => {
      const obs: Observation = {
        timestamp: "2026-03-24T12:00:00Z",
        priority: "red",
        text: "Important finding",
      };
      expect(formatObservation(obs)).toBe(
        "- [2026-03-24T12:00:00Z] [red] Important finding"
      );
    });

    it("should format observation with session", () => {
      const obs: Observation = {
        timestamp: "2026-03-24T12:00:00Z",
        priority: "yellow",
        text: "Some note",
        session: "hub",
      };
      expect(formatObservation(obs)).toBe(
        "- [2026-03-24T12:00:00Z] [yellow] Some note {session: hub}"
      );
    });
  });

  describe("filterObservations", () => {
    const now = new Date();
    const observations: Observation[] = [
      {
        timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        priority: "red",
        text: "Recent red",
        session: "hub",
      },
      {
        timestamp: new Date(
          now.getTime() - 48 * 60 * 60 * 1000
        ).toISOString(),
        priority: "yellow",
        text: "Old yellow",
        session: "project",
      },
      {
        timestamp: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        priority: "green",
        text: "Recent green",
        session: "hub",
      },
    ];

    it("should filter by priority", () => {
      const result = filterObservations(observations, { priority: "red" });
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("Recent red");
    });

    it("should filter by time window", () => {
      const result = filterObservations(observations, { sinceHours: 12 });
      expect(result).toHaveLength(2);
    });

    it("should filter by session", () => {
      const result = filterObservations(observations, { session: "hub" });
      expect(result).toHaveLength(2);
    });

    it("should combine filters", () => {
      const result = filterObservations(observations, {
        priority: "red",
        session: "hub",
      });
      expect(result).toHaveLength(1);
    });
  });
});
