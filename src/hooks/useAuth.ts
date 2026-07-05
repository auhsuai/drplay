import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startProSyncWorker } from '../utils/proSyncManager';
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

    const tokenToRevoke = localStorage.getItem("drplay_access_token");

    localStorage.removeItem("drplay_access_token");
    localStorage.removeItem("drplay_refresh_token");
    localStorage.removeItem("drplay_token_time");
    localStorage.removeItem("drplay_current_user_email");
    setIsLoggedIn(false);
    setAccessToken(null);
    setUserProfile(null);
    stopProactiveRefresh();

    try {
      await invoke("clear_stream_token");
    } catch (e) {
      console.warn("[Auth] Failed to clear backend token state", e);
    }

    if (tokenToRevoke) {
      revokeGoogleToken(tokenToRevoke);
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
    const unlisten = listen("token-expired", async () => {
      console.warn("Token expired detected by Rust proxy! Attempting silent refresh...");
      // Try to silently refresh the token instead of kicking the user out immediately (force refresh)
      const newToken = await getValidToken(true);
      if (!newToken) {
        alert("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục phát nhạc!");
        handleAuthLogout();
      } else {
        console.log("Silent refresh successful. The next play action will succeed.");
      }
    });
    
    return () => {
      window.removeEventListener('auth-logout', handleAuthLogout);
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    if (isLoggedIn && accessToken) {
      startProSyncWorker(accessToken);
      
      // Chạy đồng bộ định kỳ mỗi 2 phút
      const syncInterval = setInterval(() => {
        startProSyncWorker(accessToken);
      }, 2 * 60 * 1000);

      // Fetch User Profile
      fetchWithAuth('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
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
            // Dispatch event so utils know the user changed and can reload
            window.dispatchEvent(new CustomEvent('user-changed'));
          }
        })
        .catch(err => console.error("Failed to fetch user profile", err));
        
      return () => {
        clearInterval(syncInterval);
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
