import { useEffect, useRef } from "react";
import { useAuthStore } from "../../store/authStore";
import { updateWorkerToken } from "../../utils/proSyncManager";
import { classifyError } from "../useDriveShared";
import { logAuth } from "./authLog";

export interface AuthEventListenersDeps {
  /** Same source as useAuth's handleLogout (async, never throws to callers). */
  onLogout: () => Promise<void>;
  /** Reads isLoggingOutRef.current — blocks token resurrection mid-teardown. */
  isLoggingOut: () => boolean;
}

/**
 * Registers the two global auth window listeners exactly once (mount-once):
 * - `auth-logout` (dispatched by apiClient) delegates to the freshest
 *   handleLogout through a ref, so a mount-once listener still calls the
 *   latest closure.
 * - `token-updated` propagates a refreshed access token to the store and the
 *   running worker. It is registered unconditionally (not gated on
 *   isLoggedIn): getValidToken can dispatch the moment a refresh succeeds,
 *   including the window between login completing and the gated effects'
 *   first commit.
 */
export function useAuthEventListeners(deps: AuthEventListenersDeps): void {
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const { onLogout, isLoggingOut } = deps;

  const onLogoutRef = useRef(onLogout);
  const isLoggingOutRef = useRef(isLoggingOut);
  useEffect(() => {
    onLogoutRef.current = onLogout;
    isLoggingOutRef.current = isLoggingOut;
  }, [onLogout, isLoggingOut]);

  // Listen for auth-logout event from apiClient
  useEffect(() => {
    const handleAuthLogout = () => {
      onLogoutRef
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
  // the store/props on the stale token (race R1).
  useEffect(() => {
    const handleTokenUpdated = (e: Event) => {
      // Logout teardown spans awaits (keyring read up to 5s/revoke), and a
      // refresh already past its own session check can land inside that
      // window — the event must not resurrect a token after logout started.
      if (isLoggingOutRef.current()) return;
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
}
