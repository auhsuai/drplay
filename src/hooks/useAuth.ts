import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startProSyncWorker, stopProSyncWorker, setTokenRefreshHandler, updateWorkerToken } from '../utils/proSyncManager';
import { invalidateCurrentSession } from "../utils/sessionGuard";
import { revokeGoogleToken, stopProactiveRefresh, fetchWithAuth, getValidToken, scheduleProactiveRefresh } from "../utils/apiClient";
import { getAccessToken, setAccessToken as setStoredAccessToken, getRefreshToken, storeRefreshToken, clearRefreshToken } from "../utils/tokenStore";
import { UserProfile } from "../App"; // Or we can extract types to a separate file, but for now reuse from App.tsx
import { showErrorToast } from "../utils/simpleToast";
import { isAppError } from "../utils/appError";

const AUTH_MODULE = "useAuth";

// Actual shape of what `login_google_native` (src-tauri/src/lib.rs) resolves
// with, and therefore what LoginScreen's `onLogin` callback receives. Was
// previously typed as `(accessToken: string) => void` in LoginScreenProps,
// which never matched runtime reality (it's always this 3-field object) --
// harmless today only because both ends used `any`/loose typing, but it
// actively misled anyone reading that interface in isolation.
export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

// Standardize error context so every catch logs the module + subtype and never
// leaks the access token. Token values are never passed into these helpers.
// Several of the invoke() calls below (update_stream_token, clear_stream_token,
// clear_local_cache) now reject with a structured {kind, message} object
// (src-tauri/src/error.rs's AppError) rather than an Error instance -- this
// is logging-only (no behavior branches on the text), but still worth
// reading `.message` correctly instead of falling through to the generic
// "[non-Error thrown] [object Object]" for every failure.
const classifyError = (e: unknown): string =>
  isAppError(e) ? `[${e.kind}] ${e.message}` : e instanceof Error ? e.message : `[non-Error thrown] ${String(e)}`;

const classifyInvokeError = (e: unknown): string => {
  const msg = classifyError(e);
  const isNetworkOrIpc = /network|connection|timeout|failed to fetch|invoke|ipc/i.test(msg);
  return `${isNetworkOrIpc ? "network/Rust-IPC error" : "unexpected error"} — ${msg}`;
};

export const useAuth = (onLogoutExt?: () => void) => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  // Guard against concurrent logout: handleLogout can fire from a manual click,
  // the 'auth-logout' event (dispatched by apiClient), and the 'token-expired'
  // listener at the same time. Without this, onLogoutExt and backend cleanup run
  // multiple times (double navigation / redundant revoke calls).
  const isLoggingOutRef = useRef(false);

  // Restore session from the OS keychain (refresh token) rather than
  // localStorage. There is no persisted access token to restore -- it lives
  // in memory only (src/utils/tokenStore.ts) and is always re-derived from a
  // fresh refresh-token exchange on startup. See AUDIT.md S1 for why: the
  // refresh token is long-lived and was previously sitting in plaintext
  // localStorage, readable by any process running as the same OS user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const refreshToken = await getRefreshToken();
      if (cancelled || !refreshToken) return;
      try {
        // forceRefresh=true: getValidToken() sees no in-memory access token
        // yet anyway, but forcing makes the intent explicit and matches the
        // "always start from a fresh exchange" design.
        const freshToken = await getValidToken(true);
        if (cancelled || !freshToken) return;
        setAccessToken(freshToken);
        setIsLoggedIn(true);
      } catch (e) {
        console.warn(`[${AUTH_MODULE}] Startup refresh-token exchange failed`, classifyError(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleLoginSuccess = (tokenData: GoogleTokenResponse) => {
    if (!tokenData || typeof tokenData.access_token !== 'string' || tokenData.access_token.length === 0) {
      console.error(`[${AUTH_MODULE}] Login aborted: malformed token response (missing access_token) — no token leaked`);
      return;
    }
    setStoredAccessToken(tokenData.access_token);
    if (tokenData.refresh_token) {
      storeRefreshToken(tokenData.refresh_token).catch(e =>
        console.error(`[${AUTH_MODULE}] Failed to persist refresh token to OS keychain`, classifyError(e))
      );
    }
    setAccessToken(tokenData.access_token);
    setIsLoggedIn(true);

    // CRITICAL: Send token to Rust backend proxy immediately
    invoke("update_stream_token", { token: tokenData.access_token }).catch(e =>
      console.error(`[${AUTH_MODULE}] Login token push to Rust proxy failed (update_stream_token update)`, classifyInvokeError(e))
    );

    scheduleProactiveRefresh(tokenData.expires_in || 3600);
  };

  const handleLogout = async () => {
    if (isLoggingOutRef.current) return;
    isLoggingOutRef.current = true;
    try {
      invalidateCurrentSession();
      stopProSyncWorker();

      const tokenToRevoke = getAccessToken();

      setStoredAccessToken(null);
      await clearRefreshToken();
      localStorage.removeItem("drplay_current_user_email");
      setIsLoggedIn(false);
      setAccessToken(null);
      setUserProfile(null);
      stopProactiveRefresh();
      window.dispatchEvent(new CustomEvent('player-stop'));

      try {
        await invoke("clear_stream_token");
        await invoke("clear_local_cache");
      } catch (e) {
        console.warn(`[${AUTH_MODULE}] Failed to clear backend token/cache (clear_stream_token/clear_local_cache) — continuing logout`, classifyError(e));
      }

      if (tokenToRevoke) {
        try {
          await revokeGoogleToken(tokenToRevoke);
        } catch (e) {
          console.warn(`[${AUTH_MODULE}] Google token revoke failed — token may remain valid server-side`, classifyError(e));
        }
      }

      if (onLogoutExt) onLogoutExt();
    } finally {
      isLoggingOutRef.current = false;
    }
  };

  // Lắng nghe event logout từ apiClient
  useEffect(() => {
    const handleAuthLogout = () => {
      handleLogout().catch(err => console.error(`[${AUTH_MODULE}] Logout failed`, classifyError(err)));
    };
    window.addEventListener('auth-logout', handleAuthLogout);

    // Listen for token expiration from Rust proxy
    let unlistenFn: (() => void) | null = null;
    let listenerCancelled = false;
    listen("token-expired", async () => {
      console.warn(`[${AUTH_MODULE}] Token expiry detected by Rust proxy — attempting silent refresh...`);
      try {
        const newToken = await getValidToken(true);
        if (!newToken) {
          showErrorToast("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục phát nhạc!");
          handleAuthLogout();
        }
      } catch (e) {
        console.warn(`[${AUTH_MODULE}] Silent token refresh failed (token-expired listener)`, classifyError(e));
      }
    }).then(fn => {
      if (listenerCancelled) { fn(); return; }
      unlistenFn = fn;
    }).catch((err) => {
      // listenerCancelled just means the effect already cleaned up; an abort
      // there is expected and silent. Surface anything else for observability.
      if (!(err instanceof DOMException && err.name === 'AbortError') && !listenerCancelled) {
        console.warn(`[${AUTH_MODULE}] token-expired listener registration failed`, classifyError(err));
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
        } catch (e) {
          console.error(`[${AUTH_MODULE}] Token refresh handler failed (getValidToken) — worker unable to refresh; fallback null`, classifyError(e));
          return null;
        }
      });

      startProSyncWorker(accessToken);

      // Chạy đồng bộ định kỳ mỗi 2 phút
      const syncInterval = setInterval(() => {
        const latestToken = getAccessToken();
        if (latestToken) startProSyncWorker(latestToken);
      }, 2 * 60 * 1000);

      const handleTokenUpdated = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail?.token) {
          updateWorkerToken(detail.token);
        }
      };
      window.addEventListener('token-updated', handleTokenUpdated);

      // Fetch User Profile
      const controller = new AbortController();
      fetchWithAuth('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      })
        .then(res => {
          // fetch does not reject on 4xx/5xx — guard before parsing so an error
          // body is never mistaken for a profile. Profile is best-effort.
          if (!res.ok) throw new Error(`userinfo request failed (${res.status})`);
          return res.json();
        })
        .then(data => {
          if (data && data.email) {
            setUserProfile({
              name: data.name,
              email: data.email,
              picture: data.picture
            });
            localStorage.setItem('drplay_current_user_email', data.email);
            window.dispatchEvent(new CustomEvent('user-changed'));
          }
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name !== 'AbortError') {
            console.error(`[${AUTH_MODULE}] Failed to fetch user profile (best-effort) — profile may be incomplete`, err);
          }
        });

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
