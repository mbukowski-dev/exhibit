import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our own tests — never generated *.spec.ts files in artifact folders.
    include: ["packages/*/test/**/*.test.ts"],
  },
});
