import { useEffect } from 'react';
import { getValidToken } from '../utils/apiClient';
import { captureError } from '../utils/errorLog';

export function useAppGlobalEvents(handleLogout: () => void) {
  useEffect(() => {
    const handleFocus = () => {
      // The proactive-refresh setTimeout is frozen while the OS sleeps / the app
      // is suspended. On regaining focus, refresh if the token is stale so the
      // next play doesn't hit the proxy with an expired token. Guard on
      // refresh_token presence to avoid triggering the logout path when signed out.
      let hasTokens = false;
      try {
        hasTokens = !!(localStorage.getItem("drplay_access_token") && localStorage.getItem("drplay_refresh_token"));
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
