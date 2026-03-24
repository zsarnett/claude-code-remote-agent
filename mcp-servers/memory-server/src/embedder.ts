/**
 * Singleton embedding pipeline using HuggingFace Transformers.
 * Uses Xenova/all-MiniLM-L6-v2 for 384-dimensional embeddings.
 * Model is downloaded on first use and cached locally.
 */

import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMENSIONS = 384;

let extractorInstance: FeatureExtractionPipeline | null = null;
let initializationPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Initialize the embedding pipeline. Downloads the model on first call.
 * Subsequent calls return the cached instance.
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorInstance) {
    return extractorInstance;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    const cacheDir = join(homedir(), ".cache", "memory-mcp", "models");
    env.cacheDir = cacheDir;

    console.error(`[embedder] Loading model ${MODEL_NAME} (cache: ${cacheDir})...`);

    const extractor = await pipeline("feature-extraction", MODEL_NAME, {
      dtype: "fp32",
    });

    console.error(`[embedder] Model loaded successfully.`);
    extractorInstance = extractor as FeatureExtractionPipeline;
    return extractorInstance;
  })();

  return initializationPromise;
}

/**
 * Generate an embedding vector for a single text string.
 * Returns a 384-dimensional number array.
 */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const embedding = Array.from(output.data as Float32Array);

  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`
    );
  }

  return embedding;
}

/**
 * Generate embedding vectors for multiple texts in a batch.
 * Returns an array of 384-dimensional number arrays.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const extractor = await getExtractor();
  const results: number[][] = [];

  // Process individually to avoid shape issues with batching
  for (const text of texts) {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data as Float32Array);
    results.push(embedding);
  }

  return results;
}

/** The number of dimensions in the embedding vectors. */
export const DIMENSIONS = EMBEDDING_DIMENSIONS;
