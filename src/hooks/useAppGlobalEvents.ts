import { useEffect, useState } from 'react';
import { getValidToken } from '../utils/apiClient';

export function useAppGlobalEvents(handleLogout: () => void) {
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    const handleFocus = () => {
      setIsFocused(true);
      // The proactive-refresh setTimeout is frozen while the OS sleeps / the app
      // is suspended. On regaining focus, refresh if the token is stale so the
      // next play doesn't hit the proxy with an expired token. Guard on
      // refresh_token presence to avoid triggering the logout path when signed out.
      if (localStorage.getItem("drplay_access_token") && localStorage.getItem("drplay_refresh_token")) {
        getValidToken().catch(e => console.warn("[Auth] Focus refresh failed", e));
      }
    };
    
    const handleBlur = () => setIsFocused(false);
    
    const preventContextMenu = (e: MouseEvent) => e.preventDefault();
    
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener('contextmenu', preventContextMenu);
    
    setIsFocused(document.hasFocus());
    
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
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

  return { isFocused };
}
