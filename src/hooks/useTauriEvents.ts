import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

const TAURI_EVENT_QUOTA = "drive-quota-exceeded";

export function useTauriEvents(setShowRateLimitModal: (v: boolean) => void) {
  useEffect(() => {
    let quotaFn: (() => void) | null = null;
    let cancelled = false;

    listen(TAURI_EVENT_QUOTA, () => {
      setShowRateLimitModal(true);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      quotaFn = fn;
    });

    return () => {
      cancelled = true;
      quotaFn?.();
    };
  }, [setShowRateLimitModal]);
}
