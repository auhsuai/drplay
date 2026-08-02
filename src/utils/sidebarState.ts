// Sidebar open/closed persistence. Extracted from App.tsx so the
// localStorage contract (default-open on first launch, tolerate corrupt
// values) is testable without mounting the whole lazy-loaded app tree.

// Same drplay_* naming family as the LS_* keys in App.tsx.
export const LS_SIDEBAR_OPEN = 'drplay_sidebar_open';

// Lazy-useState-compatible reader: no stored key (first launch) OR any value
// that is not exactly 'false' → open. Only the literal 'false' collapses.
export function loadSidebarOpenState(): boolean {
  return localStorage.getItem(LS_SIDEBAR_OPEN) !== 'false';
}

export function saveSidebarOpenState(open: boolean): void {
  localStorage.setItem(LS_SIDEBAR_OPEN, String(open));
}
