import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { captureError } from "../utils/errorLog";

const TAURI_EVENT_QUOTA = "drive-quota-exceeded";

export function useTauriEvents(setShowRateLimitModal: (v: boolean) => void) {
  useEffect(() => {
    let quotaFn: (() => void) | null = null;
    let cancelled = false;

    void listen(TAURI_EVENT_QUOTA, () => {
      setShowRateLimitModal(true);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        quotaFn = fn;
      })
      .catch((err: unknown) => {
        void captureError({
          level: "warn",
          source: "useTauriEvents",
          message: `tauri-listen-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

    return () => {
      cancelled = true;
      quotaFn?.();
    };
  }, [setShowRateLimitModal]);
}
