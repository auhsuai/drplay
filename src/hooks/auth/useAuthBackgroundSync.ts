import { useEffect } from "react";
import {
  setTokenRefreshHandler,
  startProSyncWorker,
  stopProSyncWorker,
} from "../../utils/proSyncManager";
import { getValidToken } from "../../utils/apiClient";
import { useProSyncPoller } from "../useProSyncPoller";
import { classifyError } from "../useDriveShared";
import { logAuth } from "./authLog";

export interface AuthBackgroundSyncDeps {
  isLoggedIn: boolean;
  accessToken: string | null;
}

/**
 * Owns the background pro-sync lifecycle plus the periodic delta-sync poller.
 *
 * The worker effect is keyed ONLY on isLoggedIn (not accessToken): a token
 * refresh re-renders with a new accessToken, but the worker must keep running —
 * restarting it would terminate a sync in flight and lose
 * isBusy/syncRetry/full-sync progress (race R9). New tokens reach the running
 * worker via the token-updated listener (updateWorkerToken) and the worker's
 * own 401-refresh path, so the worker self-heals even if a token event is
 * missed. accessToken is deliberately captured at login time (login always
 * commits accessToken and isLoggedIn in one render); do not add it to deps.
 */
export function useAuthBackgroundSync(deps: AuthBackgroundSyncDeps): void {
  const { isLoggedIn, accessToken } = deps;

  useEffect(() => {
    if (isLoggedIn && accessToken) {
      setTokenRefreshHandler(async () => {
        try {
          return await getValidToken(true);
        } catch (e: unknown) {
          void logAuth(
            "error",
            `Token refresh handler failed (getValidToken) — worker unable to refresh; fallback null: ${classifyError(e)}`,
          );
          return null;
        }
      });

      startProSyncWorker(accessToken);

      return () => {
        stopProSyncWorker();
        setTokenRefreshHandler(null);
      };
    }
    // accessToken is deliberately captured at login time (see comment above):
    // the worker must keep running across token refreshes, and new tokens
    // reach it via updateWorkerToken / the worker's 401-refresh path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  // Periodic delta-sync poller: while logged in (token valid) it triggers a
  // sync immediately on mount, every PRO_SYNC_POLL_MS, and on window
  // focus/visibility — so files uploaded from other devices appear in
  // Recently Added without a reload. Boolean arg keeps the hook from
  // re-mounting when the accessToken refreshes (token rotations change the
  // string but not the boolean). Replaces the former 2-minute interval here
  // (same purpose, single source of truth for periodic sync).
  useProSyncPoller(isLoggedIn && !!accessToken);
}
