import { db } from "../db/db";
import { DEFAULT_USER_EMAIL } from "../utils/storageKeys";
import { logWorkerError } from "./workerError";
import { resolveTokenRefresh } from "./tokenRefresh";
import { performFullSync } from "./fullSync";
import { performDeltaSync } from "./deltaSync";
import {
  hasCurrentToken,
  setCurrentToken,
  START_PAGE_TOKEN_KEY,
} from "./syncState";

let isBusy = false;

// Schema v10 keys every files row by [userEmail+id]. The owning account now
// travels on each wire frame ({type:"sync", token, userEmail}) and is
// validated per run below — a run never reads a mutable module-level email,
// so a mid-run rotation (sentinel → real once the userinfo lands) can never
// split one pass across two owners.
export function isValidSyncOwnerEmail(
  email: string | null | undefined,
): email is string {
  return (
    typeof email === "string" &&
    email.trim().length > 0 &&
    email !== DEFAULT_USER_EMAIL
  );
}

// Entry-point bridge for the "sync" message branch: guards against a sync
// already in progress, records the token, validates the owner email, and runs
// the sync pass (busy flag cleared in a finally so a throwing pass never
// wedges the worker).
export async function runSync(
  token: string,
  userEmail?: string,
): Promise<void> {
  if (isBusy) {
    self.postMessage({ type: "SYNC_BUSY" });
    return;
  }
  if (!token) {
    self.postMessage({ type: "SYNC_NO_TOKEN" });
    return;
  }
  // Defensive owner gate — this path intentionally carries a comment. Schema
  // v10 keys rows by [userEmail+id]; running a pass without a REAL account
  // email would stamp the whole library with the shared "default" sentinel,
  // the exact cross-account-leak shape v10 exists to prevent. The main thread
  // already refuses to FIRE such syncs (proSyncManager reads the same
  // sentinel at send time); this second gate protects against any other
  // producer or a frame missing the field. Rejected BEFORE any fetch or
  // write; the 60s poller retries with the real email once it has landed.
  if (!isValidSyncOwnerEmail(userEmail)) {
    logWorkerError(
      "proSync/owner-gate",
      { phase: "runSync", receivedType: typeof userEmail },
      new Error("sync rejected: no usable owner email on the wire frame"),
      "warn",
    );
    self.postMessage({ type: "SYNC_ERROR" });
    return;
  }

  setCurrentToken(token);
  isBusy = true;
  try {
    await startProSync(userEmail);
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

async function startProSync(ownerEmail: string) {
  if (!hasCurrentToken()) return;
  try {
    const tokenState = await db.syncState.get(START_PAGE_TOKEN_KEY);

    if (!tokenState || !tokenState.value) {
      await performFullSync(ownerEmail);
    } else {
      await performDeltaSync(tokenState.value as string, ownerEmail);
    }
  } catch (err) {
    // Safety net for the Dexie read above and any error that escaped the
    // per-function handlers. We still inform the main thread.
    logWorkerError("proSync/start", {}, err, "error");
    self.postMessage({ type: "SYNC_ERROR" });
  }
}
