/**
 * Tests for the embedding pipeline.
 */

import { describe, it, expect } from "vitest";
import { embed, embedBatch, DIMENSIONS } from "../src/embedder.js";

describe("embedder", () => {
  it("should return a vector with 384 dimensions", async () => {
    const vector = await embed("This is a test sentence.");
    expect(vector).toHaveLength(DIMENSIONS);
    expect(vector).toHaveLength(384);
  });

  it("should return numbers in the vector", async () => {
    const vector = await embed("Another test.");
    for (const value of vector) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("should return normalized vectors (unit length)", async () => {
    const vector = await embed("Normalization check.");
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0)
    );
    // Should be approximately 1.0 (normalized)
    expect(magnitude).toBeCloseTo(1.0, 1);
  });

  it("should produce similar vectors for similar texts", async () => {
    const vector1 = await embed("The cat sat on the mat.");
    const vector2 = await embed("A cat was sitting on a mat.");
    const vector3 = await embed("Quantum physics describes subatomic particles.");

    // Cosine similarity (vectors are normalized, so dot product = cosine sim)
    const similaritySameContext = vector1.reduce(
      (sum, val, idx) => sum + val * vector2[idx],
      0
    );
    const similarityDifferentContext = vector1.reduce(
      (sum, val, idx) => sum + val * vector3[idx],
      0
    );

    // Similar texts should have higher similarity
    expect(similaritySameContext).toBeGreaterThan(similarityDifferentContext);
  });

  it("should handle batch embedding", async () => {
    const texts = ["First sentence.", "Second sentence.", "Third sentence."];
    const vectors = await embedBatch(texts);

    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(384);
    }
  });

  it("should return empty array for empty batch", async () => {
    const vectors = await embedBatch([]);
    expect(vectors).toHaveLength(0);
  });
});
