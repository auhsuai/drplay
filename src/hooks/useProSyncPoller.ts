import { useEffect } from "react";
import { triggerProSync } from "../utils/proSyncManager";

// Poll interval for the Drive changes feed. Google's changes API guide
// (developers.google.com/workspace/drive/api/guides/manage-changes) has apps
// save newStartPageToken "for the next polling interval" but does not mandate
// a cadence; 60s is the plan's chosen budget (~1 min until Recently Added
// updates) and costs one cheap changes.list request per tick when nothing
// changed (the worker skips files.list then).
export const PRO_SYNC_POLL_MS = 60_000;

// Debounce for focus/visibility triggers: alt-tab or quick window restores
// can fire several focus events in a burst; collapsing them into one sync
// avoids posting N sync messages for a single user action.
export const FOCUS_TRIGGER_DEBOUNCE_MS = 2_000;

// Periodic delta-sync poller (Recently Added freshness without reload).
// While `active` (logged in with a token) it:
// - triggers one sync immediately on mount (catch up on changes that
//   happened before the app was opened or while a previous session ran),
// - triggers a sync every PRO_SYNC_POLL_MS (files uploaded from other
//   devices appear without a reload),
// - triggers a debounced sync when the window gains focus or becomes
//   visible again (catch up after the window was hidden/minimized).
// The worker's own isBusy guard makes overlapping triggers no-ops.
// Cleanup clears the interval, the listeners and the pending debounce.
export function useProSyncPoller(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    triggerProSync();

    const interval = window.setInterval(triggerProSync, PRO_SYNC_POLL_MS);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const triggerDebounced = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        triggerProSync();
      }, FOCUS_TRIGGER_DEBOUNCE_MS);
    };

    const onFocus = () => {
      triggerDebounced();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        triggerDebounced();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
    };
  }, [active]);
}
