// Sidebar open/closed persistence. Extracted from App.tsx so the
// localStorage contract (default-open on first launch, tolerate corrupt
// values) is testable without mounting the whole lazy-loaded app tree.
import { safeLocalStorageGet, safeLocalStorageSet } from "./storageKeys";

// Same drplay_* naming family as the LS_* keys in App.tsx.
export const LS_SIDEBAR_OPEN = "drplay_sidebar_open";

// Lazy-useState-compatible reader: no stored key (first launch) OR any value
// that is not exactly 'false' → open. Only the literal 'false' collapses.
// localStorage access can throw SecurityError (sandboxed webview / storage
// blocked by policy — see MDN Window.localStorage), so the read is guarded:
// on failure we fall back to open (true), matching the default-open contract.
export function loadSidebarOpenState(): boolean {
  // safeLocalStorageGet returns null on failure (storage blocked) — null is
  // not the literal 'false', so the default-open contract is preserved.
  return (
    safeLocalStorageGet(
      LS_SIDEBAR_OPEN,
      "sidebar-open-read",
      "sidebarState",
    ) !== "false"
  );
}

export function saveSidebarOpenState(open: boolean): void {
  safeLocalStorageSet(
    LS_SIDEBAR_OPEN,
    String(open),
    "sidebar-open-write",
    "sidebarState",
  );
}
