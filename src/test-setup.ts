// Vitest setup shared across all test environments (node + jsdom).
// Required so @testing-library/react's act() works correctly under React 19:
// without IS_REACT_ACT_ENVIRONMENT, effect-driven async state updates keep the
// React scheduler (MessageChannel) alive and vitest never exits after hook tests.
import "@testing-library/jest-dom/vitest";

if (typeof globalThis !== "undefined") {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}
