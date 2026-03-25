import { describe, it, expect } from "vitest";
import { getProfileConfig } from "../src/search.js";

describe("search profiles", () => {
  describe("getProfileConfig", () => {
    it("should return default profile with no boosting", () => {
      const config = getProfileConfig("default");
      expect(config.fetchMultiplier).toBe(3);
      expect(config.maxAgeHours).toBeNull();
      expect(config.boostCategories).toHaveLength(0);
      expect(config.boostFactor).toBe(1.0);
    });

    it("should return planning profile with strategic boosting", () => {
      const config = getProfileConfig("planning");
      expect(config.fetchMultiplier).toBe(4);
      expect(config.maxAgeHours).toBeNull(); // Wide time window
      expect(config.boostCategories).toContain("semantic");
      expect(config.boostCategories).toContain("procedural");
      expect(config.boostTags).toContain("decision");
      expect(config.boostTags).toContain("architecture");
      expect(config.boostMetadataTypes).toContain("checkpoint");
      expect(config.boostFactor).toBe(1.5);
    });

    it("should return incident profile with narrow time window", () => {
      const config = getProfileConfig("incident");
      expect(config.maxAgeHours).toBe(48);
      expect(config.boostCategories).toContain("episodic");
      expect(config.boostTags).toContain("blocker");
      expect(config.boostTags).toContain("bug");
      expect(config.boostFactor).toBe(1.8);
    });

    it("should return handoff profile with 7-day window", () => {
      const config = getProfileConfig("handoff");
      expect(config.maxAgeHours).toBe(168); // 7 days
      expect(config.boostCategories).toContain("episodic");
      expect(config.boostCategories).toContain("procedural");
      expect(config.boostTags).toContain("checkpoint");
      expect(config.boostTags).toContain("handoff");
      expect(config.boostMetadataTypes).toContain("handoff");
      expect(config.boostFactor).toBe(1.6);
    });
  });
});
