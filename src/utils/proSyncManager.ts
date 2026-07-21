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

      if (e.data.type === 'SYNC_COMPLETE') {
        window.dispatchEvent(new CustomEvent('pro-sync-complete'));
      } else if (e.data.type === 'SYNC_ERROR') {
        // Previously dropped entirely -- the worker already logs the
        // underlying cause (logWorkerError), this just lets the main thread
        // react too (e.g. stop showing a loading state that would otherwise
        // wait forever for a completion signal that will never arrive).
        window.dispatchEvent(new CustomEvent('pro-sync-error'));
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
