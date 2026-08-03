import { useEffect, useRef, useCallback } from "react";
import { useShallow } from 'zustand/react/shallow';
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../store/authStore";
import { startProSyncWorker, stopProSyncWorker, setTokenRefreshHandler, updateWorkerToken } from '../utils/proSyncManager';
import { invalidateCurrentSession } from "../utils/sessionGuard";
import { revokeGoogleToken, stopProactiveRefresh, fetchWithAuth, getValidToken, scheduleProactiveRefresh, TOKEN_EXPIRY_MS, writeRefreshToken, readRefreshToken, deleteRefreshToken } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { clearAllMetadataCache } from "../utils/metadata";
import { captureError } from "../utils/errorLog";
import { PLAYER_STOP_EVENT } from './usePlayer';
import { USER_EMAIL_KEY, ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, TOKEN_TIME_KEY } from '../utils/storageKeys';

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const AUTH_MODULE = "useAuth";

const SYNC_INTERVAL_MS = 2 * 60 * 1000;

const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const classifyError = (e: unknown): string =>
  e instanceof Error ? e.message : `[non-Error thrown] ${String(e)}`;

export const useAuth = (onLogoutExt?: () => void) => {
  const { isLoggedIn, accessToken, userProfile, setIsLoggedIn, setAccessToken, setUserProfile } = useAuthStore(useShallow(state => ({
    isLoggedIn: state.isLoggedIn,
    accessToken: state.accessToken,
    userProfile: state.userProfile,
    setIsLoggedIn: state.setIsLoggedIn,
    setAccessToken: state.setAccessToken,
    setUserProfile: state.setUserProfile
  })));

  // Guard against concurrent logout: handleLogout can fire from a manual click
  // or the 'auth-logout' event (dispatched by apiClient) at the same time.
  // Without this, onLogoutExt and backend cleanup run multiple times (double
  // navigation / redundant revoke calls).
  const isLoggingOutRef = useRef(false);
  const onLogoutExtRef = useRef(onLogoutExt);
  onLogoutExtRef.current = onLogoutExt;

  // Initialize token from localStorage
  useEffect(() => {
    let savedToken: string | null = null;
    try {
      savedToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    } catch {
      captureError({ level: 'warn', source: AUTH_MODULE, message: 'auth-storage-read-failed' });
    }
    if (savedToken) {
      setAccessToken(savedToken);
      setIsLoggedIn(true);
      let issueTime: number;
      try {
        issueTime = parseInt(localStorage.getItem(TOKEN_TIME_KEY) || "", 10);
      } catch {
        captureError({ level: 'warn', source: AUTH_MODULE, message: 'auth-storage-read-failed' });
        issueTime = NaN;
      }
      // Corrupt/missing token_time -> treat as expired and refresh promptly
      // (scheduleProactiveRefresh clamps the minimum to 5s). The remaining
      // lifetime is measured against TOKEN_EXPIRY_MS (the stale threshold
      // getValidToken enforces), not the server's 3600s expires_in, so the
      // proactive timer always fires before the token is considered stale.
      const remainingSec = Number.isFinite(issueTime) && issueTime > 0
        ? (TOKEN_EXPIRY_MS - (Date.now() - issueTime)) / 1000
        : 0;
      scheduleProactiveRefresh(remainingSec > 0 ? remainingSec : 0);
    }
  }, []);

  const handleLoginSuccess = (tokenData: TokenData) => {
    if (isLoggingOutRef.current) return;
    if (!tokenData || typeof tokenData.access_token !== 'string' || tokenData.access_token.length === 0) {
      captureError({ level: 'error', source: AUTH_MODULE, message: 'Login aborted: malformed token response (missing access_token) — no token leaked' });
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
      captureError({ level: 'warn', source: AUTH_MODULE, message: 'auth-storage-write-failed' });
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
        captureError({ level: 'warn', source: AUTH_MODULE, message: `Failed to read refresh token for revoke — continuing logout: ${classifyError(e)}` });
      }

      let tokenToRevoke: string | null = null;
      try {
        tokenToRevoke = localStorage.getItem(ACCESS_TOKEN_KEY);

        localStorage.removeItem(ACCESS_TOKEN_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        localStorage.removeItem(TOKEN_TIME_KEY);
        localStorage.removeItem(USER_EMAIL_KEY);
      } catch {
        captureError({ level: 'warn', source: AUTH_MODULE, message: 'auth-storage-clear-failed' });
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
        captureError({ level: 'warn', source: AUTH_MODULE, message: `Failed to clear backend cache (clear_local_cache) — continuing logout: ${classifyError(e)}` });
      }

      if (tokenToRevoke) {
        try {
          await revokeGoogleToken(tokenToRevoke);
        } catch (e: unknown) {
          captureError({ level: 'warn', source: AUTH_MODULE, message: `Google token revoke failed — token may remain valid server-side: ${classifyError(e)}` });
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
  handleLogoutRef.current = handleLogout;

  // Listen for auth-logout event from apiClient
  useEffect(() => {
    const handleAuthLogout = () => {
      handleLogoutRef.current().catch((err: unknown) => captureError({ level: 'error', source: AUTH_MODULE, message: `Logout failed: ${classifyError(err)}` }));
    };
    window.addEventListener('auth-logout', handleAuthLogout);

    return () => {
      window.removeEventListener('auth-logout', handleAuthLogout);
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
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.token === 'string') {
        setAccessToken(detail.token);
        updateWorkerToken(detail.token);
      }
    };
    window.addEventListener('token-updated', handleTokenUpdated);
    return () => {
      window.removeEventListener('token-updated', handleTokenUpdated);
    };
  }, []);

  // Worker lifecycle is keyed ONLY on isLoggedIn (not accessToken): a token
  // refresh re-renders with a new accessToken, but the worker must keep
  // running — restarting it would terminate a sync in flight and lose
  // isBusy/syncRetry/full-sync progress (race R9). New tokens reach the
  // running worker via updateWorkerToken (B2 token-updated listener) and the
  // periodic interval below re-reads localStorage, so the worker self-heals
  // even if a token event is missed. accessToken is deliberately captured at
  // login time (login always commits accessToken and isLoggedIn in one
  // render); do not add it to deps.
  useEffect(() => {
    if (isLoggedIn && accessToken) {
      setTokenRefreshHandler(async () => {
        try {
          return await getValidToken(true);
        } catch (e: unknown) {
          captureError({ level: 'error', source: AUTH_MODULE, message: `Token refresh handler failed (getValidToken) — worker unable to refresh; fallback null: ${classifyError(e)}` });
          return null;
        }
      });

      startProSyncWorker(accessToken);

      // Run periodic sync every 2 minutes
      const syncInterval = setInterval(() => {
        try {
          const latestToken = localStorage.getItem(ACCESS_TOKEN_KEY);
          if (latestToken) startProSyncWorker(latestToken);
        } catch {
          captureError({ level: 'warn', source: AUTH_MODULE, message: 'auth-storage-read-failed' });
        }
      }, SYNC_INTERVAL_MS);

      return () => {
        clearInterval(syncInterval);
        stopProSyncWorker();
        setTokenRefreshHandler(null);
      };
    }
  }, [isLoggedIn]);

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
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`userinfo request failed (${res.status})`);
          const data = await res.json() as Record<string, unknown> | null;
          if (data && typeof data.email === 'string') {
            setUserProfile({
              name: typeof data.name === 'string' ? data.name : '',
              email: data.email,
              picture: typeof data.picture === 'string' ? data.picture : ''
            });
            try {
              localStorage.setItem(USER_EMAIL_KEY, data.email);
            } catch {
              captureError({ level: 'warn', source: AUTH_MODULE, message: 'auth-storage-write-failed' });
            }
            window.dispatchEvent(new CustomEvent('user-changed'));
          }
        } catch (err: unknown) {
          if (err instanceof Error && err.name !== 'AbortError') {
            captureError({ level: 'error', source: AUTH_MODULE, message: `Failed to fetch user profile (best-effort): ${err.message}` });
          }
        }
      })();

      return () => {
        controller.abort();
      };
    }
  }, [isLoggedIn, accessToken]);

  return {
    isLoggedIn,
    accessToken,
    userProfile,
    handleLoginSuccess,
    handleLogout
  };
};
