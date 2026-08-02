import { useEffect } from 'react';
import { captureError } from '../utils/errorLog';

const SW_SCOPE = '/sw.js';
const TOKEN_STORAGE_KEY = 'drplay_access_token';
const MSG_UPDATE_TOKEN = 'UPDATE_TOKEN';
const EVENT_TOKEN_UPDATED = 'token-updated';

// postMessage to a service worker can throw (e.g. InvalidStateError when the
// worker is redundant); a token push must never break the SW lifecycle, so
// failures are logged and swallowed.
function safePost(target: ServiceWorker | null | undefined, message: { type: string; token?: string }): void {
  if (!target) return;
  try {
    target.postMessage(message);
  } catch (e: unknown) {
    captureError({ level: 'warn', source: 'useServiceWorker', message: `sw-post-failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}

// TODO: migrate to @tauri-apps/plugin-store for encrypted storage
export function useServiceWorker(token?: string) {
  const getToken = () => token ?? localStorage.getItem(TOKEN_STORAGE_KEY);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(SW_SCOPE).then(reg => {
        const t = getToken();
        if (t) {
          // The just-registered worker may still be installing; navigator.serviceWorker.ready
          // resolves only once the registration has an ACTIVE worker (MDN
          // ServiceWorkerContainer.ready), so this postMessage never hits a
          // non-active worker and cannot throw a mislabeled "registration failed".
          navigator.serviceWorker.ready.then(readyReg => {
            safePost(readyReg.active, { type: MSG_UPDATE_TOKEN, token: t });
          }).catch(err => {
            captureError({ level: 'warn', source: 'useServiceWorker', message: `SW ready failed: ${err instanceof Error ? err.message : String(err)}` });
          });
        }

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          const currentToken = getToken();
          if (newWorker && currentToken) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                const freshToken = getToken();
                if (freshToken) {
                  safePost(newWorker, { type: MSG_UPDATE_TOKEN, token: freshToken });
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
          safePost(navigator.serviceWorker.controller, { type: MSG_UPDATE_TOKEN, token: t });
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
        safePost(navigator.serviceWorker.controller, { type: MSG_UPDATE_TOKEN, token: t });
      }
    };
    window.addEventListener(EVENT_TOKEN_UPDATED, handleTokenUpdated);
    return () => window.removeEventListener(EVENT_TOKEN_UPDATED, handleTokenUpdated);
  }, []);
}
