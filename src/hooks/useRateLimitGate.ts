import { useEffect, useState } from "react";
import { useTauriEvents } from "./useTauriEvents";
import { DEBUG_EVENTS, onDebugEvent } from "../ui/debug/debugEvents";

/**
 * App-level rate-limit modal state + its two triggers (real Tauri event and
 * the DEV-only debug panel). Extracted verbatim from App.tsx.
 */
export function useRateLimitGate() {
  const [showRateLimitModal, setShowRateLimitModal] = useState(false);

  // Listen to Tauri events (Quota Exceeded, Repair Thumbnail)
  useTauriEvents(setShowRateLimitModal);

  // DEV-only debug trigger: same setShowRateLimitModal path as the Tauri
  // path as the Tauri event, so the modal opens exactly like a real quota
  // failure. The helper no-ops in production builds.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.RATE_LIMIT, () => {
      setShowRateLimitModal(true);
    });
  }, [setShowRateLimitModal]);

  return { showRateLimitModal, setShowRateLimitModal };
}
