// Sidebar open/closed persistence. Extracted from App.tsx so the
// localStorage contract (default-open on first launch, tolerate corrupt
// values) is testable without mounting the whole lazy-loaded app tree.
import { captureError } from "./errorLog";

// Same drplay_* naming family as the LS_* keys in App.tsx.
export const LS_SIDEBAR_OPEN = "drplay_sidebar_open";

// Lazy-useState-compatible reader: no stored key (first launch) OR any value
// that is not exactly 'false' → open. Only the literal 'false' collapses.
// localStorage access can throw SecurityError (sandboxed webview / storage
// blocked by policy — see MDN Window.localStorage), so the read is guarded:
// on failure we fall back to open (true), matching the default-open contract.
export function loadSidebarOpenState(): boolean {
  try {
    return localStorage.getItem(LS_SIDEBAR_OPEN) !== "false";
  } catch (err) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "sidebarState",
      message: `sidebar-open-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
    return true;
  }
}

export function saveSidebarOpenState(open: boolean): void {
  try {
    localStorage.setItem(LS_SIDEBAR_OPEN, String(open));
  } catch (err) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "sidebarState",
      message: `sidebar-open-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
  }
}
