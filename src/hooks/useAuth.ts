import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startProSyncWorker, stopProSyncWorker, setTokenRefreshHandler, updateWorkerToken } from '../utils/proSyncManager';
import { invalidateCurrentSession } from "../utils/sessionGuard";
import { revokeGoogleToken, stopProactiveRefresh, fetchWithAuth, getValidToken, scheduleProactiveRefresh } from "../utils/apiClient";
import { clearAllMetadataCache } from "../utils/metadata";
import { UserProfile } from "../App"; // Or we can extract types to a separate file, but for now reuse from App.tsx
import { showErrorToast } from "../utils/simpleToast";

const AUTH_MODULE = "useAuth";

// Standardize error context so every catch logs the module + subtype and never
// leaks the access token. Token values are never passed into these helpers.
const classifyError = (e: unknown): string =>
  e instanceof Error ? e.message : `[non-Error thrown] ${String(e)}`;

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

  // Initialize token from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem("drplay_access_token");
    if (savedToken) {
      setAccessToken(savedToken);
      setIsLoggedIn(true);
      // Push the restored token to the Rust proxy before any playback can start.
      invoke("update_stream_token", { token: savedToken }).catch(e =>
        console.error(`[${AUTH_MODULE}] Restored token push to Rust proxy failed (update_stream_token init)`, classifyInvokeError(e))
      );
      const issueTime = parseInt(localStorage.getItem("drplay_token_time") || "", 10);
      // Corrupt/missing token_time -> treat as expired and refresh promptly
      // (scheduleProactiveRefresh clamps the minimum to 5s).
      const remainingSec = Number.isFinite(issueTime) && issueTime > 0
        ? 3600 - (Date.now() - issueTime) / 1000
        : 0;
      scheduleProactiveRefresh(remainingSec > 0 ? remainingSec : 0);
    }
  }, []);

  const handleLoginSuccess = (tokenData: any) => {
    if (!tokenData || typeof tokenData.access_token !== 'string' || tokenData.access_token.length === 0) {
      console.error(`[${AUTH_MODULE}] Login aborted: malformed token response (missing access_token) — no token leaked`);
      return;
    }
    localStorage.setItem("drplay_access_token", tokenData.access_token);
    localStorage.setItem("drplay_token_time", Date.now().toString());
    if (tokenData.refresh_token) {
      localStorage.setItem("drplay_refresh_token", tokenData.refresh_token);
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

      const tokenToRevoke = localStorage.getItem("drplay_access_token");

      localStorage.removeItem("drplay_access_token");
      localStorage.removeItem("drplay_refresh_token");
      localStorage.removeItem("drplay_token_time");
      localStorage.removeItem("drplay_current_user_email");
      setIsLoggedIn(false);
      setAccessToken(null);
      setUserProfile(null);
      stopProactiveRefresh();
      window.dispatchEvent(new CustomEvent('player-stop'));

      try {
        await invoke("clear_stream_token");
        await invoke("clear_local_cache");
        clearAllMetadataCache();
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
        const latestToken = localStorage.getItem("drplay_access_token");
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
