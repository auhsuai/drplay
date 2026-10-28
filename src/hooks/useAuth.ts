import { useEffect, useRef, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAuthStore } from "../store/authStore";
import {
  scheduleProactiveRefresh,
  TOKEN_EXPIRY_MS,
  writeRefreshToken,
} from "../utils/apiClient";
import { ACCESS_TOKEN_KEY, TOKEN_TIME_KEY } from "../utils/storageKeys";
import { logAuth } from "./auth/authLog";
import { runLogoutCleanup } from "./auth/logoutCleanup";
import { useAuthEventListeners } from "./auth/useAuthEventListeners";
import { useAuthBackgroundSync } from "./auth/useAuthBackgroundSync";
import { useAuthProfileSync } from "./auth/useAuthProfileSync";

interface TokenData {
  access_token: string;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
}

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
    isAuthHydrated,
    accessToken,
    userProfile,
    setIsLoggedIn,
    setIsAuthHydrated,
    setAccessToken,
    setUserProfile,
  } = useAuthStore(
    useShallow((state) => ({
      isLoggedIn: state.isLoggedIn,
      isAuthHydrated: state.isAuthHydrated,
      accessToken: state.accessToken,
      userProfile: state.userProfile,
      setIsLoggedIn: state.setIsLoggedIn,
      setIsAuthHydrated: state.setIsAuthHydrated,
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
    // P2-04-9: hydrate settled — the login gate may now paint its logged-out
    // state. Set LAST so no earlier step can leave the gate undecided.
    setIsAuthHydrated(true);
  }, [setAccessToken, setIsLoggedIn, setIsAuthHydrated]);

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
      await runLogoutCleanup({
        clearLoginState: () => {
          setIsLoggedIn(false);
          setAccessToken(null);
          setUserProfile(null);
        },
        getOnLogoutExt: () => onLogoutExtRef.current,
      });
    } finally {
      isLoggingOutRef.current = false;
    }
  }, [setIsLoggedIn, setAccessToken, setUserProfile]);
  useAuthEventListeners({
    onLogout: handleLogout,
    isLoggingOut: () => isLoggingOutRef.current,
  });
  useAuthBackgroundSync({ isLoggedIn, accessToken });
  useAuthProfileSync({ isLoggedIn, accessToken });

  return {
    isLoggedIn,
    isAuthHydrated,
    accessToken,
    userProfile,
    handleLoginSuccess,
    handleLogout,
  };
};
