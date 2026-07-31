import { useEffect } from 'react';
import { captureError } from '../utils/errorLog';

const SW_SCOPE = '/sw.js';
const TOKEN_STORAGE_KEY = 'drplay_access_token';
const MSG_UPDATE_TOKEN = 'UPDATE_TOKEN';
const EVENT_TOKEN_UPDATED = 'token-updated';

export function useServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(SW_SCOPE).then(reg => {
        console.log('[SW] Registered', reg);
        const token = localStorage.getItem(TOKEN_STORAGE_KEY);
        if (token && reg.active) {
          reg.active.postMessage({ type: MSG_UPDATE_TOKEN, token });
        }
      }).catch(err => {
        captureError({ level: 'error', source: 'useServiceWorker', message: `SW Registration failed: ${err instanceof Error ? err.message : String(err)}` });
      });

      const handleControllerChange = () => {
        const token = localStorage.getItem(TOKEN_STORAGE_KEY);
        if (token && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: MSG_UPDATE_TOKEN, token });
        }
      };
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
      return () => navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    }
  }, []);

  useEffect(() => {
    const handleTokenUpdated = (ev: Event) => {
      const token = (ev as CustomEvent<{ token: string }>).detail?.token;
      if (navigator.serviceWorker && navigator.serviceWorker.controller && token) {
        navigator.serviceWorker.controller.postMessage({ type: MSG_UPDATE_TOKEN, token });
      }
    };
    window.addEventListener(EVENT_TOKEN_UPDATED, handleTokenUpdated);
    return () => window.removeEventListener(EVENT_TOKEN_UPDATED, handleTokenUpdated);
  }, []);
}
