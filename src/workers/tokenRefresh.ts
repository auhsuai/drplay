import { logWorkerError } from "./workerError";

const TOKEN_REFRESH_TIMEOUT_MS = 15000;

let tokenRefreshResolver: ((value: boolean) => void) | null = null;

export function resolveTokenRefresh(ok: boolean): void {
  if (tokenRefreshResolver) {
    tokenRefreshResolver(ok);
    tokenRefreshResolver = null;
  }
}

async function waitForTokenRefresh(
  timeoutMs = TOKEN_REFRESH_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      tokenRefreshResolver = null;
      resolve(false);
    }, timeoutMs);
    tokenRefreshResolver = (ok: boolean) => {
      clearTimeout(timer);
      tokenRefreshResolver = null;
      resolve(ok);
    };
  });
}

export interface SyncRetryState {
  count: number;
  max: number;
}

// Injected deps so unit tests can stub postMessage / waitForTokenRefresh
// without a real worker scope or network.
export interface RefreshTokenRetryDeps {
  postMessage: (msg: { type: string }) => void;
  waitForTokenRefresh: () => Promise<boolean>;
}

// Shared 401 handler used by all three Drive fetch loops (full-sync
// startPageToken, full-sync files, delta-sync changes). Returns true when the
// caller should retry the request after a successful token refresh; returns
// false when it must give up (retries exhausted) or the refresh failed, and
// the caller decides whether to return/break. Extracted so the retry-count
// logic lives in one place instead of being copy-pasted three times.
export async function refreshTokenAndRetry(
  state: SyncRetryState,
  deps: RefreshTokenRetryDeps,
  ctx: string,
): Promise<boolean> {
  if (state.count >= state.max) {
    logWorkerError(
      "proSync/" + ctx,
      { kind: "auth", status: 401, reason: "max-retries" },
      new Error("token refresh retries exhausted"),
      "error",
    );
    deps.postMessage({ type: "SYNC_ERROR" });
    return false;
  }
  state.count += 1;
  deps.postMessage({ type: "TOKEN_EXPIRED" });
  const refreshed = await deps.waitForTokenRefresh();
  if (refreshed) {
    state.count = 0;
    return true;
  }
  return false;
}

// Production bindings: post to the worker's parent scope and wait on the
// module-level refresh resolver. Tests inject their own deps instead.
const syncRetryDeps: RefreshTokenRetryDeps = {
  postMessage: (msg) => {
    self.postMessage(msg);
  },
  waitForTokenRefresh: () => waitForTokenRefresh(),
};

export { syncRetryDeps };
