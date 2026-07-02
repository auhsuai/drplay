export function startProSyncWorker(token: string) {
  const worker = new Worker(new URL('../workers/proSync.worker.ts', import.meta.url), {
    type: 'module'
  });
  
  worker.onmessage = (e) => {
    if (e.data.type === 'SYNC_PROGRESS') {
      window.dispatchEvent(new CustomEvent('pro-sync-progress'));
    } else if (e.data.type === 'SYNC_COMPLETE') {
      window.dispatchEvent(new CustomEvent('pro-sync-complete'));
    }
  };
  
  worker.postMessage({ token });
}
