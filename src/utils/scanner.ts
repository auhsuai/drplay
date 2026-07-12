let globalScannerWorker: Worker | null = null;

export function startGlobalBackgroundScanner(token: string) {
  if (globalScannerWorker) {
    globalScannerWorker.terminate();
    globalScannerWorker = null;
  }
  const worker = new Worker(new URL('../workers/scanner.worker.ts', import.meta.url), {
    type: 'module'
  });
  
  worker.postMessage({ token });
  globalScannerWorker = worker;
}

export function stopGlobalBackgroundScanner() {
  if (globalScannerWorker) {
    globalScannerWorker.terminate();
    globalScannerWorker = null;
  }
}
