import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startProSyncWorker, stopProSyncWorker, setTokenRefreshHandler, updateWorkerToken } from '../utils/proSyncManager';
import { invalidateCurrentSession } from "../utils/sessionGuard";
import { revokeGoogleToken, stopProactiveRefresh, fetchWithAuth, getValidToken, scheduleProactiveRefresh } from "../utils/apiClient";
import { UserProfile } from "../App"; // Or we can extract types to a separate file, but for now reuse from App.tsx

export const useAuth = (onLogoutExt?: () => void) => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);

  // Initialize token from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem("drplay_access_token");
    if (savedToken) {
      setAccessToken(savedToken);
      setIsLoggedIn(true);
      invoke("update_stream_token", { token: savedToken }).catch(e => console.error("Rust stream token init fail", e));
      const issueTime = parseInt(localStorage.getItem("drplay_token_time") || "0");
      const elapsedSec = (Date.now() - issueTime) / 1000;
      const remainingSec = 3600 - elapsedSec;
      scheduleProactiveRefresh(remainingSec > 0 ? remainingSec : 0);
    }
  }, []);

  const handleLoginSuccess = (tokenData: any) => {
    localStorage.setItem("drplay_access_token", tokenData.access_token);
    localStorage.setItem("drplay_token_time", Date.now().toString());
    if (tokenData.refresh_token) {
      localStorage.setItem("drplay_refresh_token", tokenData.refresh_token);
    }
    setAccessToken(tokenData.access_token);
    setIsLoggedIn(true);
    
    // CRITICAL: Send token to Rust backend proxy immediately
    invoke("update_stream_token", { token: tokenData.access_token }).catch(e => console.error("Rust stream token update fail", e));
    
    scheduleProactiveRefresh(tokenData.expires_in || 3600);
  };

  const handleLogout = async () => {
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
    } catch (e) {
      console.warn("[Auth] Failed to clear backend token or cache", e);
    }

    if (tokenToRevoke) {
      await revokeGoogleToken(tokenToRevoke);
    }

    if (onLogoutExt) onLogoutExt();
  };

  // Lắng nghe event logout từ apiClient
  useEffect(() => {
    const handleAuthLogout = () => {
      handleLogout();
    };
    window.addEventListener('auth-logout', handleAuthLogout);
    
    // Listen for token expiration from Rust proxy
    let unlistenFn: (() => void) | null = null;
    let listenerCancelled = false;
    listen("token-expired", async () => {
      console.warn("Token expired detected by Rust proxy! Attempting silent refresh...");
      try {
        const newToken = await getValidToken(true);
        if (!newToken) {
          alert("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục phát nhạc!");
          handleAuthLogout();
        } else {
          console.log("Silent refresh successful. The next play action will succeed.");
        }
      } catch (e) {
        console.warn("Silent refresh failed", e);
      }
    }).then(fn => {
      if (listenerCancelled) { fn(); return; }
      unlistenFn = fn;
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
        } catch {
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
        .then(res => res.json())
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
        .catch(err => {
          if (err.name !== 'AbortError') console.error("Failed to fetch user profile", err);
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
