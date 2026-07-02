export function startGlobalBackgroundScanner(token: string) {
  // Use Vite's worker import syntax
  const worker = new Worker(new URL('../workers/scanner.worker.ts', import.meta.url), {
    type: 'module'
  });
  
  worker.postMessage({ token });
}
