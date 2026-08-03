import { useEffect } from 'react';
import { getValidToken } from '../utils/apiClient';
import { captureError } from '../utils/errorLog';
import { ACCESS_TOKEN_KEY } from '../utils/storageKeys';

export function useAppGlobalEvents(handleLogout: () => void) {
  useEffect(() => {
    const handleFocus = () => {
      // The proactive-refresh setTimeout is frozen while the OS sleeps / the app
      // is suspended. On regaining focus, refresh if the token is stale so the
      // next play doesn't hit the proxy with an expired token. Guard on access
      // token presence only: the refresh token lives in the OS keyring since
      // the M1b/M1c migration, so it is no longer in localStorage (checking it
      // would skip the refresh for every keyring user). Signed-out users have
      // no access token, so the logout path stays unreachable.
      let hasTokens = false;
      try {
        hasTokens = !!localStorage.getItem(ACCESS_TOKEN_KEY);
      } catch {
        // Storage can throw (privacy mode / quota); a read failure must not
        // crash focus handling — skip the refresh and let the next play fail.
        captureError({ level: 'warn', source: 'useAppGlobalEvents', message: 'auth-storage-read-failed' });
      }
      if (hasTokens) {
        getValidToken().catch(e => captureError({ level: 'warn', source: 'useAppGlobalEvents', message: `Focus refresh failed: ${e instanceof Error ? e.message : String(e)}` }));
      }
    };
    
    const preventContextMenu = (e: MouseEvent) => e.preventDefault();
    
    window.addEventListener("focus", handleFocus);
    document.addEventListener('contextmenu', preventContextMenu);
    
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener('contextmenu', preventContextMenu);
    };
  }, []);

  // Listen to apiClient logout event
  useEffect(() => {
    const handleAuthLogout = () => {
      handleLogout();
    };
    window.addEventListener('auth-logout', handleAuthLogout);
    return () => window.removeEventListener('auth-logout', handleAuthLogout);
  }, [handleLogout]);
}
