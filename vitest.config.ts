import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/api/test/**/*.test.ts"],
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**", "packages/agents/src/**", "packages/motion/src/**"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 },
    },
  },
});
