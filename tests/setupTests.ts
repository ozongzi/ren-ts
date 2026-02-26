/**
 * Test setup for Vitest + Testing Library
 *
 * - Loads jest-dom matchers so you can use `expect(...).toBeInTheDocument()` and friends.
 * - Ensures DOM cleanup after each test.
 * - Provides a minimal `matchMedia` polyfill to avoid errors from components that use it.
 *
 * This file is referenced from `vitest.config.ts` via `setupFiles`.
 */

import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Minimal window.matchMedia polyfill for tests that rely on CSS/media queries.
// Keeps tests deterministic and avoids errors in environments (jsdom) that don't implement it.
if (typeof window !== 'undefined' && !('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      // legacy listeners (some libs still call these)
      addListener: () => {},
      removeListener: () => {},
      // modern event listeners
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Ensure Testing Library cleans up mounted trees between tests, and restore any mocks.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
