import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    consolidate: "scripts/consolidate.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  shims: false,
  external: ["@lancedb/lancedb", "@huggingface/transformers"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
