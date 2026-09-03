import { useEffect, useRef, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../store/authStore";
import {
  startProSyncWorker,
  stopProSyncWorker,
  setTokenRefreshHandler,
  updateWorkerToken,
} from "../utils/proSyncManager";
import { useProSyncPoller } from "./useProSyncPoller";
import { isAbortError } from "./player/utils";
import { invalidateCurrentSession } from "../utils/sessionGuard";
import {
  revokeGoogleToken,
  stopProactiveRefresh,
  fetchWithAuth,
  getValidToken,
  scheduleProactiveRefresh,
  TOKEN_EXPIRY_MS,
  writeRefreshToken,
  readRefreshToken,
  deleteRefreshToken,
} from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { db } from "../db/db";
import { authHeaders } from "../utils/driveFiles";
import { clearAllMetadataCache } from "../utils/metadata";
import { captureError } from "../utils/errorLog";
import { PLAYER_STOP_EVENT } from "./usePlayer";
import {
  USER_EMAIL_KEY,
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_TIME_KEY,
  getCurrentUserEmail,
} from "../utils/storageKeys";

interface TokenData {
  access_token: string;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
}

const AUTH_MODULE = "useAuth";

// Dexie syncState key holding the Drive changes start-page token. Must stay
// byte-identical to START_PAGE_TOKEN_KEY in src/workers/syncState.ts (the
// worker module is deliberately NOT imported here — it would bundle the whole
// sync pipeline into the main thread just for one string constant).
const SYNC_START_PAGE_TOKEN_KEY = "startPageToken";

const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const classifyError = (e: unknown): string =>
  e instanceof Error ? e.message : `[non-Error thrown] ${String(e)}`;

const logAuth = (level: "warn" | "error", message: string): Promise<void> =>
  captureError({ level, source: AUTH_MODULE, message });

/**
 * Auth lifecycle hook: hydrates the session from localStorage on mount,
 * starts/stops the pro-sync worker and proactive token refresh while logged
 * in, fetches the Google profile, and owns logout (invalidate session, stop
 * workers, clear storage, revoke both tokens, wipe backend caches, then run
 * the caller's `onLogoutExt`). Returns the current auth state plus the two
 * handlers every login/logout UI needs:
 * - `handleLoginSuccess(tokenData)` — persist tokens from the login flow,
 *   flip the store to logged-in, and schedule the proactive refresh. Safe to
 *   call multiple times: it ignores malformed payloads and races a logout in
 *   progress.
 * - `handleLogout()` — the full teardown above, guarded so concurrent logout
 *   triggers (button + 'auth-logout' event) run exactly once. Async but
 *   always resolves; never throws to its callers.
 * @param onLogoutExt Optional callback invoked at the END of a successful
 * logout (e.g. navigation) — wrapped in a ref, so a fresh identity each
 * render is fine.
 */
export const useAuth = (onLogoutExt?: () => void) => {
  const {
    isLoggedIn,
    accessToken,
    userProfile,
    setIsLoggedIn,
    setAccessToken,
    setUserProfile,
  } = useAuthStore(
    useShallow((state) => ({
      isLoggedIn: state.isLoggedIn,
      accessToken: state.accessToken,
      userProfile: state.userProfile,
      setIsLoggedIn: state.setIsLoggedIn,
      setAccessToken: state.setAccessToken,
      setUserProfile: state.setUserProfile,
    })),
  );

  // Guard against concurrent logout: handleLogout can fire from a manual click
  // or the 'auth-logout' event (dispatched by apiClient) at the same time.
  // Without this, onLogoutExt and backend cleanup run multiple times (double
  // navigation / redundant revoke calls).
  const isLoggingOutRef = useRef(false);
  const isLoggingOut = () => isLoggingOutRef.current;
  const onLogoutExtRef = useRef(onLogoutExt);
  useEffect(() => {
    onLogoutExtRef.current = onLogoutExt;
  }, [onLogoutExt]);

  // Initialize token from localStorage
  useEffect(() => {
    let savedToken: string | null = null;
    try {
      savedToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    } catch {
      void logAuth("warn", "auth-storage-read-failed");
    }
    if (savedToken) {
      setAccessToken(savedToken);
      setIsLoggedIn(true);
      let issueTime: number;
      try {
        issueTime = parseInt(localStorage.getItem(TOKEN_TIME_KEY) || "", 10);
      } catch {
        void logAuth("warn", "auth-storage-read-failed");
        issueTime = NaN;
      }
      // Corrupt/missing token_time -> treat as expired and refresh promptly
      // (scheduleProactiveRefresh clamps the minimum to 5s). The remaining
      // lifetime is measured against TOKEN_EXPIRY_MS (the stale threshold
      // getValidToken enforces), not the server's 3600s expires_in, so the
      // proactive timer always fires before the token is considered stale.
      const remainingSec =
        Number.isFinite(issueTime) && issueTime > 0
          ? (TOKEN_EXPIRY_MS - (Date.now() - issueTime)) / 1000
          : 0;
      scheduleProactiveRefresh(remainingSec > 0 ? remainingSec : 0);
    }
  }, [setAccessToken, setIsLoggedIn]);

  const handleLoginSuccess = (tokenData: TokenData | null | undefined) => {
    if (isLoggingOut()) return;
    if (
      !tokenData ||
      typeof tokenData.access_token !== "string" ||
      tokenData.access_token.length === 0
    ) {
      void logAuth(
        "error",
        "Login aborted: malformed token response (missing access_token) — no token leaked",
      );
      return;
    }
    try {
      localStorage.setItem(ACCESS_TOKEN_KEY, tokenData.access_token);
      localStorage.setItem(TOKEN_TIME_KEY, Date.now().toString());
      if (tokenData.refresh_token) {
        // The keyring (via writeRefreshToken) is the source of truth for the
        // long-lived token; never persist it to localStorage directly.
        // writeRefreshToken removes the legacy LS copy on keyring success and
        // keeps it (logged) as a degraded fallback on failure — it never
        // rejects, so this stays fire-and-forget.
        void writeRefreshToken(tokenData.refresh_token);
      }
    } catch {
      void logAuth("warn", "auth-storage-write-failed");
    }
    setAccessToken(tokenData.access_token);
    setIsLoggedIn(true);

    // Fallback to TOKEN_EXPIRY_MS/1000 (the stale threshold) when the backend
    // omits expires_in — consistent with apiClient's single expiry model.
    scheduleProactiveRefresh(tokenData.expires_in || TOKEN_EXPIRY_MS / 1000);
  };

  const handleLogout = useCallback(async () => {
    if (isLoggingOutRef.current) return;
    isLoggingOutRef.current = true;
    try {
      invalidateCurrentSession();
      stopProSyncWorker();

      // Account identity for the per-user DB wipe below must be captured
      // BEFORE the localStorage clear that follows (same reason
      // refreshTokenToRevoke is read first).
      const loggingOutEmail = getCurrentUserEmail();

      // Read the long-lived refresh token BEFORE the localStorage clear
      // below: readRefreshToken falls back to the legacy LS copy when the
      // keyring read fails, so reading after the clear would silently skip
      // the revoke. A read failure (keyring + LS both unreachable) must not
      // block logout — log a warn and continue; deleteRefreshToken below
      // still wipes any keyring/LS residue.
      let refreshTokenToRevoke: string | null = null;
      try {
        refreshTokenToRevoke = await readRefreshToken();
      } catch (e: unknown) {
        void logAuth(
          "warn",
          `Failed to read refresh token for revoke — continuing logout: ${classifyError(e)}`,
        );
      }

      let tokenToRevoke: string | null = null;
      try {
        tokenToRevoke = localStorage.getItem(ACCESS_TOKEN_KEY);

        localStorage.removeItem(ACCESS_TOKEN_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        localStorage.removeItem(TOKEN_TIME_KEY);
        localStorage.removeItem(USER_EMAIL_KEY);
      } catch {
        void logAuth("warn", "auth-storage-clear-failed");
      }
      setIsLoggedIn(false);
      setAccessToken(null);
      setUserProfile(null);
      stopProactiveRefresh();
      window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));

      try {
        // clear_stream_token was removed from the backend during the Service
        // Worker migration (commit a134f77) — only clear_local_cache remains.
        await invoke(CLEAR_LOCAL_CACHE_CMD);
        clearAllMetadataCache();
      } catch (e: unknown) {
        void logAuth(
          "warn",
          `Failed to clear backend cache (clear_local_cache) — continuing logout: ${classifyError(e)}`,
        );
      }

      // Account-boundary wipe: the offline mirror rows and the per-account
      // metadata caches are keyed by user — only the logged-out account's
      // mirror is removed. The "default" sentinel identifies no real account,
      // so there is nothing reliably owned to wipe for it (wiping it could
      // destroy legacy-migrated rows). Fire-and-forget exactly like the
      // metadata cache clear above: IDB latency must not block logout;
      // failures are logged, never silent, and logout never rejects.
      if (loggingOutEmail.trim().length > 0 && loggingOutEmail !== "default") {
        void db.files.clear().catch((e: unknown) => {
          void logAuth(
            "warn",
            `Files persisted-wipe failed — continuing logout: ${classifyError(e)}`,
          );
        });
      }

      // Sync-cursor teardown: the Drive changes startPageToken in db.syncState
      // is account-scoped state — left behind, the NEXT login would delta-sync
      // the previous account's change window onto its own fresh mirror.
      // Deleted INDEPENDENTLY of the file wipe above (a failed wipe must not
      // preserve the stale cursor) and best-effort like every logout step:
      // failure logged, logout continues.
      void db.syncState
        .delete(SYNC_START_PAGE_TOKEN_KEY)
        .catch((e: unknown) => {
          void logAuth(
            "warn",
            `Failed to delete sync startPageToken — continuing logout: ${classifyError(e)}`,
          );
        });

      if (tokenToRevoke) {
        try {
          await revokeGoogleToken(tokenToRevoke);
        } catch (e: unknown) {
          void logAuth(
            "warn",
            `Google token revoke failed — token may remain valid server-side: ${classifyError(e)}`,
          );
        }
      }

      // Revoke the long-lived refresh token too: the Google revoke endpoint
      // accepts refresh tokens as well as access tokens, so a leaked refresh
      // credential cannot stay valid after logout. revokeGoogleToken never
      // throws (non-blocking, logs internally), so no local try/catch needed.
      if (refreshTokenToRevoke) {
        await revokeGoogleToken(refreshTokenToRevoke);
      }

      // Remove the long-lived refresh token from the OS credential vault
      // (keyring) — the LS copy is already cleared above. Fire-and-forget:
      // deleteRefreshToken never rejects, so a vault hiccup cannot break
      // logout (shared-machine safety: no credential residue).
      void deleteRefreshToken();

      onLogoutExtRef.current?.();
    } finally {
      isLoggingOutRef.current = false;
    }
  }, [setIsLoggedIn, setAccessToken, setUserProfile]);

  const handleLogoutRef = useRef(handleLogout);
  useEffect(() => {
    handleLogoutRef.current = handleLogout;
  }, [handleLogout]);

  // Listen for auth-logout event from apiClient
  useEffect(() => {
    const handleAuthLogout = () => {
      handleLogoutRef
        .current()
        .catch(
          (err: unknown) =>
            void logAuth("error", `Logout failed: ${classifyError(err)}`),
        );
    };
    window.addEventListener("auth-logout", handleAuthLogout);

    return () => {
      window.removeEventListener("auth-logout", handleAuthLogout);
    };
  }, []);

  // Listen for token refresh events unconditionally from mount. Registered
  // OUTSIDE the login-gated effect because getValidToken can dispatch
  // token-updated the moment a refresh succeeds — including the window
  // between login completing and the gated effect's first commit. A
  // listener that mounts only after login would miss that event and leave
  // the store/props on the stale token (race R1). Safe to be unconditional:
  // apiClient only dispatches token-updated after its session guard passes,
  // so no stale post-logout event can arrive.
  useEffect(() => {
    const handleTokenUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ token?: unknown } | null>).detail;
      const token = detail?.token;
      if (typeof token === "string") {
        setAccessToken(token);
        updateWorkerToken(token);
      }
    };
    window.addEventListener("token-updated", handleTokenUpdated);
    return () => {
      window.removeEventListener("token-updated", handleTokenUpdated);
    };
  }, [setAccessToken]);

  // Worker lifecycle is keyed ONLY on isLoggedIn (not accessToken): a token
  // refresh re-renders with a new accessToken, but the worker must keep
  // running — restarting it would terminate a sync in flight and lose
  // isBusy/syncRetry/full-sync progress (race R9). New tokens reach the
  // running worker via updateWorkerToken (B2 token-updated listener) and the
  // worker's own 401-refresh path, so the worker self-heals even if a token
  // event is missed. accessToken is deliberately captured at login time
  // (login always commits accessToken and isLoggedIn in one render); do not
  // add it to deps.
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

  // Fetch User Profile (best-effort, fire-and-forget). Keyed on
  // [isLoggedIn, accessToken] on purpose: profile should refetch whenever the
  // token rotates (same behavior as the pre-split gated effect). The
  // AbortController only cancels the in-flight fetch — it must NOT touch the
  // worker, which is owned by the lifecycle effect above.
  useEffect(() => {
    if (isLoggedIn && accessToken) {
      const controller = new AbortController();
      void (async () => {
        try {
          const res = await fetchWithAuth(GOOGLE_USERINFO_URL, {
            headers: authHeaders(accessToken),
            signal: controller.signal,
          });
          if (!res.ok)
            throw new Error(`userinfo request failed (${String(res.status)})`);
          const data = (await res.json()) as Record<string, unknown> | null;
          if (data && typeof data.email === "string") {
            setUserProfile({
              name: typeof data.name === "string" ? data.name : "",
              email: data.email,
              picture: typeof data.picture === "string" ? data.picture : "",
            });
            try {
              localStorage.setItem(USER_EMAIL_KEY, data.email);
            } catch {
              void logAuth("warn", "auth-storage-write-failed");
            }
            window.dispatchEvent(new CustomEvent("user-changed"));
          }
        } catch (err: unknown) {
          if (!isAbortError(err)) {
            // isAbortError does not narrow the type, so fall back to the same
            // name/message extraction used elsewhere (classifyFolderError).
            const message = err instanceof Error ? err.message : String(err);
            void logAuth(
              "error",
              `Failed to fetch user profile (best-effort): ${message}`,
            );
          }
        }
      })();

      return () => {
        controller.abort();
      };
    }
  }, [isLoggedIn, accessToken, setUserProfile]);

  return {
    isLoggedIn,
    accessToken,
    userProfile,
    handleLoginSuccess,
    handleLogout,
  };
};
