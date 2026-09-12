import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@t3-vibe/core": resolve("packages/core/src/index.ts"),
      "@t3-vibe/adapter-t3": resolve("packages/adapter-t3/src/index.ts"),
      "@t3-vibe/persistence": resolve("packages/persistence/src/index.ts"),
      "@t3-vibe/frontend-telegram": resolve("packages/frontend-telegram/src/index.ts"),
      "@t3-vibe/compatibility": resolve("packages/compatibility/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
