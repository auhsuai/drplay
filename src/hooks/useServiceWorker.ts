import { useEffect } from 'react';
import { captureError } from '../utils/errorLog';

const SW_SCOPE = '/sw.js';
const TOKEN_STORAGE_KEY = 'drplay_access_token';
const MSG_UPDATE_TOKEN = 'UPDATE_TOKEN';
const EVENT_TOKEN_UPDATED = 'token-updated';

// TODO: migrate to @tauri-apps/plugin-store for encrypted storage
export function useServiceWorker(token?: string) {
  const getToken = () => token ?? localStorage.getItem(TOKEN_STORAGE_KEY);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(SW_SCOPE).then(reg => {
        const t = getToken();
        if (t) {
          const worker = reg.installing || reg.waiting || reg.active;
          if (worker) worker.postMessage({ type: MSG_UPDATE_TOKEN, token: t });
        }

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          const currentToken = getToken();
          if (newWorker && currentToken) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                const freshToken = getToken();
                if (freshToken) {
                  newWorker.postMessage({ type: MSG_UPDATE_TOKEN, token: freshToken });
                }
              }
            });
          }
        });
      }).catch(err => {
        captureError({ level: 'error', source: 'useServiceWorker', message: `SW Registration failed: ${err instanceof Error ? err.message : String(err)}` });
      });

      const handleControllerChange = () => {
        const t = getToken();
        if (t && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: MSG_UPDATE_TOKEN, token: t });
        }
      };
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
      return () => navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    }
  }, [token]);

  useEffect(() => {
    const handleTokenUpdated = (ev: Event) => {
      const t = (ev as CustomEvent<{ token: string }>).detail?.token;
      if (navigator.serviceWorker && navigator.serviceWorker.controller && t) {
        navigator.serviceWorker.controller.postMessage({ type: MSG_UPDATE_TOKEN, token: t });
      }
    };
    window.addEventListener(EVENT_TOKEN_UPDATED, handleTokenUpdated);
    return () => window.removeEventListener(EVENT_TOKEN_UPDATED, handleTokenUpdated);
  }, []);
}
