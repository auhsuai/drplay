let globalWorker: Worker | null = null;

export function startProSyncWorker(token: string) {
  if (!globalWorker) {
    globalWorker = new Worker(new URL('../workers/proSync.worker.ts', import.meta.url), {
      type: 'module'
    });
    
    globalWorker.onmessage = (e) => {
      if (e.data.type === 'SYNC_PROGRESS') {
        window.dispatchEvent(new CustomEvent('pro-sync-progress'));
      } else if (e.data.type === 'SYNC_COMPLETE') {
        window.dispatchEvent(new CustomEvent('pro-sync-complete'));
      }
    };
  }
  
  globalWorker.postMessage({ token });
}
