// Sidebar open/closed persistence. Extracted from App.tsx so the
// localStorage contract (default-open on desktop first launch, default-closed
// on mobile, tolerate corrupt values) is testable without mounting the whole
// lazy-loaded app tree.
import { captureError } from "./errorLog";
import { IS_MOBILE } from "./platform";

// Same drplay_* naming family as the LS_* keys in App.tsx.
export const LS_SIDEBAR_OPEN = "drplay_sidebar_open";

// Lazy-useState-compatible reader. Stored value wins whenever one exists:
// only the literal 'false' collapses, anything else (including corrupt)
// opens — unchanged desktop contract. When NO key is stored (first launch)
// the default is platform-aware: desktop opens, mobile closes. Mobile
// default-closed (Task 9 follow-up) stops the hardware-back sidebar handler
// from silently swallowing the first back press to collapse an invisible
// sidebar — back then reaches the double-back exit toast immediately.
// localStorage access can throw SecurityError (sandboxed webview / storage
// blocked by policy — see MDN Window.localStorage), so the read is guarded:
// on failure we fall back to the platform default (open on desktop, closed
// on mobile), matching the no-key contract.
export function loadSidebarOpenState(): boolean {
  try {
    const saved = localStorage.getItem(LS_SIDEBAR_OPEN);
    return saved !== null ? saved !== "false" : !IS_MOBILE;
  } catch (err) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "sidebarState",
      message: `sidebar-open-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
    return !IS_MOBILE;
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
