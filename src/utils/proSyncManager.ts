import { captureError } from "./errorLog";

// Named constants for the worker->main protocol (message types) and the
// main->UI protocol (CustomEvent names). Worker messages were previously
// matched by raw string literals; the worker file still posts the same
// strings, so the runtime protocol is unchanged.
export const SYNC_EVENT_NAMES = {
  progress: "pro-sync-progress",
  complete: "pro-sync-complete",
  busy: "pro-sync-busy",
  noToken: "pro-sync-no-token",
  error: "pro-sync-error",
} as const;

const WORKER_MSG_TYPES = {
  tokenExpired: "TOKEN_EXPIRED",
  progress: "SYNC_PROGRESS",
  complete: "SYNC_COMPLETE",
  busy: "SYNC_BUSY",
  noToken: "SYNC_NO_TOKEN",
  error: "SYNC_ERROR",
  // Main->worker REPLY to TOKEN_EXPIRED meaning "the refresh cannot be done"
  // (handler missing / returned null / threw). Mirrors the worker-side
  // REFRESH_FAILED_TYPE literal in src/workers/tokenRefresh.ts so the runtime
  // protocol stays identical on both ends.
  refreshFailed: "refresh_failed",
} as const;

// Main->worker request types (the worker's isWorkerRequestMessage matches
// these literals): "sync" triggers a delta/full sync pass, "token" pushes a
// refreshed token into the running worker.
const WORKER_REQUEST_TYPES = {
  sync: "sync",
  token: "token",
} as const;

// Value union of the wire-level strings the worker can post (the switch
// matches against these values, so the union is derived from the values).
export type WorkerMsgType =
  (typeof WORKER_MSG_TYPES)[keyof typeof WORKER_MSG_TYPES];
// Union of the CustomEvent names dispatched to the UI layer.
type SyncEventName = (typeof SYNC_EVENT_NAMES)[keyof typeof SYNC_EVENT_NAMES];

let globalWorker: Worker | null = null;
let onTokenRefreshRequest: (() => Promise<string | null>) | null = null;
// Most recent token handed to the worker (login or refresh). The periodic
// poller (useProSyncPoller) re-triggers syncs with this token via
// triggerProSync, so a re-sync never needs the caller to pass the token again.
let lastToken: string | null = null;

export function setTokenRefreshHandler(
  handler: (() => Promise<string | null>) | null,
) {
  onTokenRefreshRequest = handler;
}

export function updateWorkerToken(token: string) {
  lastToken = token;
  if (globalWorker) {
    globalWorker.postMessage({ type: WORKER_REQUEST_TYPES.token, token });
  }
}

// Re-triggers a delta sync with the last known token. No-op (never throws)
// while the worker has not been started or no token is known yet — the
// poller only runs while logged in, so both cases are transient. The worker's
// own isBusy guard turns an overlapping sync into a harmless SYNC_BUSY.
export function triggerProSync(): void {
  if (!globalWorker || !lastToken) return;
  globalWorker.postMessage({
    type: WORKER_REQUEST_TYPES.sync,
    token: lastToken,
  });
}

// Injectable deps so the handler is unit-testable without a real Worker or
// window (vitest node environment).
export interface ProSyncHandlerDeps {
  onTokenRefreshRequest: (() => Promise<string | null>) | null;
  updateToken: (token: string) => void;
  dispatch: (name: SyncEventName) => void;
  logError: (msg: string) => void;
  // Replies {type:"refresh_failed"} to the worker so a pending 401 wait
  // resolves immediately instead of stalling for the worker-side timeout.
  notifyRefreshFailed: () => void;
}

// Routes every worker->main message. Previously SYNC_BUSY / SYNC_NO_TOKEN /
// SYNC_ERROR fell through silently (no log, no UI event); they now surface
// via logError + a CustomEvent so failures are never swallowed.
export async function handleWorkerMessage(
  msg: { type?: WorkerMsgType },
  deps: ProSyncHandlerDeps,
): Promise<void> {
  switch (msg.type) {
    case WORKER_MSG_TYPES.tokenExpired: {
      // Every path that cannot produce a refreshed token must answer the
      // worker with {type:"refresh_failed"} so it stops waiting right away.
      // Silence here used to stall the worker until its internal 15s timeout.
      if (!deps.onTokenRefreshRequest) {
        deps.notifyRefreshFailed();
        break;
      }
      try {
        const newToken = await deps.onTokenRefreshRequest();
        if (newToken) {
          deps.updateToken(newToken);
        } else {
          deps.notifyRefreshFailed();
        }
      } catch (err) {
        deps.logError(
          `pro-sync: token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        deps.notifyRefreshFailed();
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
      deps.logError("pro-sync: no token provided to worker");
      deps.dispatch(SYNC_EVENT_NAMES.noToken);
      break;
    case WORKER_MSG_TYPES.error:
      deps.logError("pro-sync: worker sync failed");
      deps.dispatch(SYNC_EVENT_NAMES.error);
      break;
    default:
      // Unknown message types are ignored safely (forward compatibility).
      break;
  }
}

export function startProSyncWorker(token: string) {
  lastToken = token;
  if (!globalWorker) {
    globalWorker = new Worker(
      new URL("../workers/proSync.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );

    const deps: ProSyncHandlerDeps = {
      onTokenRefreshRequest,
      updateToken: updateWorkerToken,
      dispatch: (name) => window.dispatchEvent(new CustomEvent(name)),
      logError: (msg) => {
        // captureError never throws; failure to persist is warned internally.
        void captureError({
          source: "proSyncManager",
          message: msg,
          level: "error",
        });
      },
      notifyRefreshFailed: () => {
        globalWorker?.postMessage({
          type: WORKER_MSG_TYPES.refreshFailed,
        });
      },
    };

    globalWorker.onmessage = (e) => {
      // Non-object payloads (e.g. a bare string) are ignored — same runtime
      // behavior as before (msg.type would be undefined → default case).
      if (typeof e.data === "object" && e.data !== null) {
        void handleWorkerMessage(e.data as { type?: WorkerMsgType }, deps);
      }
    };
    globalWorker.onerror = (e) => {
      void captureError({
        level: "error",
        source: "proSyncManager",
        message: `worker-error: ${e.message}`,
      });
      window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAMES.error));
    };
    globalWorker.onmessageerror = () => {
      void captureError({
        level: "error",
        source: "proSyncManager",
        message: "worker-messageerror: malformed message from worker",
      });
    };
  }

  globalWorker.postMessage({ type: WORKER_REQUEST_TYPES.sync, token });
}

export function stopProSyncWorker() {
  if (globalWorker) {
    globalWorker.terminate();
    globalWorker = null;
  }
}
