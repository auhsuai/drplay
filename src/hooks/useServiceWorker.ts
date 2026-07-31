import { useEffect } from 'react';

export function useServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        console.log('[SW] Registered', reg);
        const token = localStorage.getItem('drplay_access_token');
        if (token && reg.active) {
          reg.active.postMessage({ type: 'UPDATE_TOKEN', token });
        }
      }).catch(err => {
        console.error('[SW] Registration failed', err);
      });

      const handleControllerChange = () => {
        const token = localStorage.getItem('drplay_access_token');
        if (token && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'UPDATE_TOKEN', token });
        }
      };
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
      return () => navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    }
  }, []);

  useEffect(() => {
    const handleTokenUpdated = (e: any) => {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'UPDATE_TOKEN', token: e.detail.token });
      }
    };
    window.addEventListener('token-updated', handleTokenUpdated);
    return () => window.removeEventListener('token-updated', handleTokenUpdated);
  }, []);
}
