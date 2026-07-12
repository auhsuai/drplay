let globalWorker: Worker | null = null;
let onTokenRefreshRequest: (() => Promise<string | null>) | null = null;

export function setTokenRefreshHandler(handler: () => Promise<string | null>) {
  onTokenRefreshRequest = handler;
}

export function updateWorkerToken(token: string) {
  if (globalWorker) {
    globalWorker.postMessage({ type: 'token', token });
  }
}

export function startProSyncWorker(token: string) {
  if (!globalWorker) {
    globalWorker = new Worker(new URL('../workers/proSync.worker.ts', import.meta.url), {
      type: 'module'
    });

    globalWorker.onmessage = async (e) => {
      if (e.data.type === 'TOKEN_EXPIRED') {
        if (onTokenRefreshRequest) {
          const newToken = await onTokenRefreshRequest();
          if (newToken) {
            updateWorkerToken(newToken);
          }
        }
        return;
      }

      if (e.data.type === 'SYNC_PROGRESS') {
        window.dispatchEvent(new CustomEvent('pro-sync-progress'));
      } else if (e.data.type === 'SYNC_COMPLETE') {
        window.dispatchEvent(new CustomEvent('pro-sync-complete'));
      }
    };
  }

  globalWorker.postMessage({ type: 'sync', token });
}

export function stopProSyncWorker() {
  if (globalWorker) {
    globalWorker.terminate();
    globalWorker = null;
  }
}
