import { useEffect, useRef, useCallback } from "react";
import { useShallow } from 'zustand/react/shallow';
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../store/authStore";
import { listen } from "@tauri-apps/api/event";
import { startProSyncWorker, stopProSyncWorker, setTokenRefreshHandler, updateWorkerToken } from '../utils/proSyncManager';
import { invalidateCurrentSession } from "../utils/sessionGuard";
import { revokeGoogleToken, stopProactiveRefresh, fetchWithAuth, getValidToken, scheduleProactiveRefresh } from "../utils/apiClient";
import { clearAllMetadataCache } from "../utils/metadata";
import { captureError } from "../utils/errorLog";
import { showErrorToast } from "../utils/simpleToast";

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const AUTH_MODULE = "useAuth";

const DEFAULT_EXPIRES_SECONDS = 3600;
const SYNC_INTERVAL_MS = 2 * 60 * 1000;

const LS_ACCESS_TOKEN = 'drplay_access_token';
const LS_REFRESH_TOKEN = 'drplay_refresh_token';
const LS_TOKEN_TIME = 'drplay_token_time';
const LS_USER_EMAIL = 'drplay_current_user_email';

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

  // Guard against concurrent logout: handleLogout can fire from a manual click,
  // the 'auth-logout' event (dispatched by apiClient), and the 'token-expired'
  // listener at the same time. Without this, onLogoutExt and backend cleanup run
  // multiple times (double navigation / redundant revoke calls).
  const isLoggingOutRef = useRef(false);
  const onLogoutExtRef = useRef(onLogoutExt);
  onLogoutExtRef.current = onLogoutExt;

  // Initialize token from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem(LS_ACCESS_TOKEN);
    if (savedToken) {
      setAccessToken(savedToken);
      setIsLoggedIn(true);
      const issueTime = parseInt(localStorage.getItem(LS_TOKEN_TIME) || "", 10);
      // Corrupt/missing token_time -> treat as expired and refresh promptly
      // (scheduleProactiveRefresh clamps the minimum to 5s).
      const remainingSec = Number.isFinite(issueTime) && issueTime > 0
        ? DEFAULT_EXPIRES_SECONDS - (Date.now() - issueTime) / 1000
        : 0;
      scheduleProactiveRefresh(remainingSec > 0 ? remainingSec : 0);
    }
  }, []);

  const handleLoginSuccess = (tokenData: TokenData) => {
    if (!tokenData || typeof tokenData.access_token !== 'string' || tokenData.access_token.length === 0) {
      captureError({ level: 'error', source: AUTH_MODULE, message: 'Login aborted: malformed token response (missing access_token) — no token leaked' });
      return;
    }
    localStorage.setItem(LS_ACCESS_TOKEN, tokenData.access_token);
    localStorage.setItem(LS_TOKEN_TIME, Date.now().toString());
    if (tokenData.refresh_token) {
      localStorage.setItem(LS_REFRESH_TOKEN, tokenData.refresh_token);
    }
    setAccessToken(tokenData.access_token);
    setIsLoggedIn(true);

    scheduleProactiveRefresh(tokenData.expires_in || DEFAULT_EXPIRES_SECONDS);
  };

  const handleLogout = useCallback(async () => {
    if (isLoggingOutRef.current) return;
    isLoggingOutRef.current = true;
    try {
      invalidateCurrentSession();
      stopProSyncWorker();

      const tokenToRevoke = localStorage.getItem(LS_ACCESS_TOKEN);

      localStorage.removeItem(LS_ACCESS_TOKEN);
      localStorage.removeItem(LS_REFRESH_TOKEN);
      localStorage.removeItem(LS_TOKEN_TIME);
      localStorage.removeItem(LS_USER_EMAIL);
      setIsLoggedIn(false);
      setAccessToken(null);
      setUserProfile(null);
      stopProactiveRefresh();
      window.dispatchEvent(new CustomEvent('player-stop'));

      try {
        await invoke("clear_stream_token");
        await invoke("clear_local_cache");
        clearAllMetadataCache();
      } catch (e: unknown) {
        captureError({ level: 'warn', source: AUTH_MODULE, message: `Failed to clear backend token/cache (clear_stream_token/clear_local_cache) — continuing logout: ${classifyError(e)}` });
      }

      if (tokenToRevoke) {
        try {
          await revokeGoogleToken(tokenToRevoke);
        } catch (e: unknown) {
          captureError({ level: 'warn', source: AUTH_MODULE, message: `Google token revoke failed — token may remain valid server-side: ${classifyError(e)}` });
        }
      }

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

    // Listen for token expiration from Rust proxy
    let unlistenFn: (() => void) | null = null;
    let listenerCancelled = false;
    listen("token-expired", async () => {
      captureError({ level: 'warn', source: AUTH_MODULE, message: 'Token expiry detected, attempting silent refresh' });
      try {
        const newToken = await getValidToken(true);
        if (!newToken) {
          showErrorToast("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục phát nhạc!");
          handleAuthLogout();
        }
      } catch (e: unknown) {
        captureError({ level: 'warn', source: AUTH_MODULE, message: `Silent token refresh failed (token-expired listener): ${classifyError(e)}` });
      }
    }).then(fn => {
      if (listenerCancelled) { fn(); return; }
      unlistenFn = fn;
    }).catch((err: unknown) => {
      // listenerCancelled just means the effect already cleaned up; an abort
      // there is expected and silent. Surface anything else for observability.
      if (!(err instanceof DOMException && err.name === 'AbortError') && !listenerCancelled) {
        captureError({ level: 'warn', source: AUTH_MODULE, message: `token-expired listener registration failed: ${classifyError(err)}` });
      }
    });

    return () => {
      listenerCancelled = true;
      window.removeEventListener('auth-logout', handleAuthLogout);
      unlistenFn?.();
    };
  }, []);

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
        const latestToken = localStorage.getItem(LS_ACCESS_TOKEN);
        if (latestToken) startProSyncWorker(latestToken);
      }, SYNC_INTERVAL_MS);

      const handleTokenUpdated = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (typeof detail?.token === 'string') {
          updateWorkerToken(detail.token);
        }
      };
      window.addEventListener('token-updated', handleTokenUpdated);

      // Fetch User Profile (best-effort, fire-and-forget)
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
            localStorage.setItem(LS_USER_EMAIL, data.email);
            window.dispatchEvent(new CustomEvent('user-changed'));
          }
        } catch (err: unknown) {
          if (err instanceof Error && err.name !== 'AbortError') {
            captureError({ level: 'error', source: AUTH_MODULE, message: `Failed to fetch user profile (best-effort): ${err.message}` });
          }
        }
      })();

      return () => {
        clearInterval(syncInterval);
        stopProSyncWorker();
        controller.abort();
        window.removeEventListener('token-updated', handleTokenUpdated);
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
