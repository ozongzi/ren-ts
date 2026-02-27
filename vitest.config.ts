import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest configuration for the renpy_reader project.
 *
 * - Runs tests in a `jsdom` environment (suitable for React components / DOM APIs).
 * - Loads a global setup file at `tests/setupTests.ts`.
 * - Collects coverage using the `v8` provider and emits `text` and `lcov` reports.
 *
 * Notes:
 * - Tests live under `tests/` and the rrs module lives at `rrs/` at repo root.
 * - Coverage "all: true" + explicit include ensures the standalone `rrs/` module
 *   is considered in coverage output.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    // Use globals like `describe` / `it` without imports
    globals: true,

    // Simulate a browser environment (DOM)
    environment: "jsdom",

    // File that runs before the test suite (setup mocks, extend expect, etc.)
    setupFiles: "tests/setupTests.ts",

    // Patterns for test files
    include: [
      "tests/**/*.spec.ts",
      "tests/**/*.spec.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],

    // Exclude large/irrelevant paths
    exclude: ["node_modules", "dist", "build", "coverage", "tests/fixtures/**"],

    // Per-test timeout (ms)
    testTimeout: 10_000,

    // Coverage configuration
    coverage: {
      // Use istanbul provider for coverage reporting (via @vitest/coverage-istanbul)
      provider: "istanbul",

      // Report formats: printed to console and lcov for CI
      reporter: ["text", "lcov"],

      // Collect coverage across the src tree and the standalone rrs module
      all: true,
      include: ["src/**/*.ts", "rrs/**/*.ts"],

      // Files/dirs to exclude from coverage
      exclude: [
        "**/*.d.ts",
        "src/**/*.d.ts",
        "src/**/__tests__/**",
        "tests/**",
        "node_modules/**",
      ],

      // Optional thresholds (adjust as needed)
      statements: 60,
      branches: 60,
      functions: 60,
      lines: 60,
    },

    // Run tests in a single thread in CI-like environments to get deterministic output.
    // Vitest will still use multiple threads locally where useful.
    // CI workflows can set VITEST_JOBS=1 if desired.
  },
});
