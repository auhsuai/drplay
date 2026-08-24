// Vitest setup shared across all test environments (node + jsdom).
// Required so @testing-library/react's act() works correctly under React 19:
// without IS_REACT_ACT_ENVIRONMENT, effect-driven async state updates keep the
// React scheduler (MessageChannel) alive and vitest never exits after hook tests.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

if (typeof globalThis !== "undefined") {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}

// simpleToast mounts .app-toast on document.body, outside RTL's render
// container — RTL cleanup never removes those nodes, so a toast from one
// test leaks into the next. Guarded because the default vitest environment
// here is node (no document).
if (typeof document !== "undefined") {
  afterEach(() => {
    document.querySelectorAll(".app-toast").forEach((el) => {
      el.remove();
    });
  });
}
