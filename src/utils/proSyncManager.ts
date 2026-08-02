import { captureError } from './errorLog';

// Named constants for the worker->main protocol (message types) and the
// main->UI protocol (CustomEvent names). Worker messages were previously
// matched by raw string literals; the worker file still posts the same
// strings, so the runtime protocol is unchanged.
export const SYNC_EVENT_NAMES = {
  progress: 'pro-sync-progress',
  complete: 'pro-sync-complete',
  busy: 'pro-sync-busy',
  noToken: 'pro-sync-no-token',
  error: 'pro-sync-error',
} as const;

const WORKER_MSG_TYPES = {
  tokenExpired: 'TOKEN_EXPIRED',
  progress: 'SYNC_PROGRESS',
  complete: 'SYNC_COMPLETE',
  busy: 'SYNC_BUSY',
  noToken: 'SYNC_NO_TOKEN',
  error: 'SYNC_ERROR',
} as const;

// Value union of the wire-level strings the worker can post (the switch
// matches against these values, so the union is derived from the values).
export type WorkerMsgType = (typeof WORKER_MSG_TYPES)[keyof typeof WORKER_MSG_TYPES];
// Union of the CustomEvent names dispatched to the UI layer.
type SyncEventName = (typeof SYNC_EVENT_NAMES)[keyof typeof SYNC_EVENT_NAMES];

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

// Injectable deps so the handler is unit-testable without a real Worker or
// window (vitest node environment).
export interface ProSyncHandlerDeps {
  onTokenRefreshRequest: (() => Promise<string | null>) | null;
  updateToken: (token: string) => void;
  dispatch: (name: SyncEventName) => void;
  logError: (msg: string) => void;
}

// Routes every worker->main message. Previously SYNC_BUSY / SYNC_NO_TOKEN /
// SYNC_ERROR fell through silently (no log, no UI event); they now surface
// via logError + a CustomEvent so failures are never swallowed.
export async function handleWorkerMessage(
  msg: { type?: WorkerMsgType },
  deps: ProSyncHandlerDeps
): Promise<void> {
  switch (msg.type) {
    case WORKER_MSG_TYPES.tokenExpired: {
      if (!deps.onTokenRefreshRequest) break;
      try {
        const newToken = await deps.onTokenRefreshRequest();
        if (newToken) {
          deps.updateToken(newToken);
        }
      } catch (err) {
        deps.logError(
          `pro-sync: token refresh failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      break;
    }
    case WORKER_MSG_TYPES.progress:
      deps.dispatch(SYNC_EVENT_NAMES.progress);
      break;
    case WORKER_MSG_TYPES.complete:
      deps.dispatch(SYNC_EVENT_NAMES.complete);
      break;
    case WORKER_MSG_TYPES.busy:
      // Not an error: the worker is still running the previous sync.
      deps.dispatch(SYNC_EVENT_NAMES.busy);
      break;
    case WORKER_MSG_TYPES.noToken:
      deps.logError('pro-sync: no token provided to worker');
      deps.dispatch(SYNC_EVENT_NAMES.noToken);
      break;
    case WORKER_MSG_TYPES.error:
      deps.logError('pro-sync: worker sync failed');
      deps.dispatch(SYNC_EVENT_NAMES.error);
      break;
    default:
      // Unknown message types are ignored safely (forward compatibility).
      break;
  }
}

export function startProSyncWorker(token: string) {
  if (!globalWorker) {
    globalWorker = new Worker(new URL('../workers/proSync.worker.ts', import.meta.url), {
      type: 'module'
    });

    const deps: ProSyncHandlerDeps = {
      onTokenRefreshRequest,
      updateToken: updateWorkerToken,
      dispatch: (name) => window.dispatchEvent(new CustomEvent(name)),
      logError: (msg) => {
        // captureError never throws; failure to persist is warned internally.
        void captureError({ source: 'proSyncManager', message: msg, level: 'error' });
      },
    };

    globalWorker.onmessage = (e) => {
      void handleWorkerMessage(e.data, deps);
    };
    globalWorker.onerror = (e) => {
      void captureError({
        level: 'error',
        source: 'proSyncManager',
        message: `worker-error: ${e.message ?? 'unknown worker error'}`,
      });
      window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAMES.error));
    };
    globalWorker.onmessageerror = () => {
      void captureError({
        level: 'error',
        source: 'proSyncManager',
        message: 'worker-messageerror: malformed message from worker',
      });
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
