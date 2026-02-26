import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the renpy_reader project.
 *
 * - Runs tests in a `jsdom` environment (suitable for React components / DOM APIs).
 * - Loads a global setup file at `tests/setupTests.ts`.
 * - Collects coverage using the `v8` provider and emits `text`, `lcov` and `html` reports.
 *
 * Notes:
 * - Keep `tests/` as the primary place for unit tests/fixtures to avoid polluting src.
 * - Coverage thresholds are intentionally modest to start with; raise them as tests improve.
 */
export default defineConfig({
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
      "src/**/*.spec.ts",
      "src/**/*.spec.tsx",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],

    // Exclude large/irrelevant paths
    exclude: ["node_modules", "dist", "build", "coverage", "tests/fixtures/**"],

    // Per-test timeout (ms)
    testTimeout: 10_000,

    // Coverage configuration
    coverage: {
      provider: "istanbul",

      // Report formats: printed to console, lcov file for CI, and HTML for browsing
      reporter: ["text", "lcov", "html"],

      // Where to output coverage reports
      reportsDirectory: "coverage",

      // Collect coverage across the src tree by default
      all: true,
      include: ["src/**/*.{ts,tsx,js,jsx}"],

      // Files/dirs to exclude from coverage
      exclude: [
        "**/*.d.ts",
        "src/**/*.d.ts",
        "src/**/__tests__/**",
        "tests/**",
        "node_modules/**",
      ],

      // Minimal thresholds (can be enforced later in CI)
      statements: 60,
      branches: 60,
      functions: 60,
      lines: 60,
    },

    // Run tests in a single thread in CI-like environments to get deterministic output.
    // Vitest will still use multiple threads locally where useful.
    // We leave this unset here; CI workflows can set VITEST_JOBS=1 if desired.
  },
});
