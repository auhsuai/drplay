import { db } from "../db/db";
import { logWorkerError } from "./workerError";
import { resolveTokenRefresh } from "./tokenRefresh";
import { performFullSync } from "./fullSync";
import { performDeltaSync } from "./deltaSync";
import {
  START_PAGE_TOKEN_KEY,
  hasCurrentToken,
  setCurrentToken,
} from "./syncState";

let isBusy = false;

// Entry-point bridge for the "sync" message branch: guards against a sync
// already in progress, records the token, and runs the sync pass (busy flag
// cleared in a finally so a throwing pass never wedges the worker).
export async function runSync(token: string): Promise<void> {
  if (isBusy) {
    self.postMessage({ type: "SYNC_BUSY" });
    return;
  }
  if (!token) {
    self.postMessage({ type: "SYNC_NO_TOKEN" });
    return;
  }

  setCurrentToken(token);
  isBusy = true;
  try {
    await startProSync();
  } finally {
    isBusy = false;
  }
}

// Entry-point bridge for the "token" message branch: records the refreshed
// token and resolves a pending 401 token-refresh wait (no-op when none is
// pending).
export function pushToken(token: string): void {
  setCurrentToken(token);
  resolveTokenRefresh(true);
}

async function startProSync() {
  if (!hasCurrentToken()) return;
  try {
    const tokenState = await db.syncState.get(START_PAGE_TOKEN_KEY);

    if (!tokenState || !tokenState.value) {
      await performFullSync();
    } else {
      await performDeltaSync(tokenState.value as string);
    }
  } catch (err) {
    // Safety net for the Dexie read above and any error that escaped the
    // per-function handlers. We still inform the main thread.
    logWorkerError("proSync/start", {}, err, "error");
    self.postMessage({ type: "SYNC_ERROR" });
  }
}
