import { pushToken, runSync } from "./syncRunner";
import {
  REFRESH_FAILED_TYPE,
  refreshTokenAndRetry,
  resolveTokenRefresh,
} from "./tokenRefresh";
import type { RefreshTokenRetryDeps, SyncRetryState } from "./tokenRefresh";
import { delay, fetchDrive, isTransientStatus } from "./driveFetch";
import {
  isValidDriveFile,
  partitionValidFiles,
  toDriveFileRow,
  toUpsertableFileRow,
} from "./driveMapping";

// userEmail rides on both request frames (schema v10 per-account stamping).
// It is OPTIONAL at the guard level so a frame missing the field reaches
// runSync's owner gate, which rejects it with an explicit SYNC_ERROR instead
// of silently dropping the message (no terminal signal would stall the UI).
type WorkerRequestMessage =
  | { type: "sync"; token: string; userEmail?: string }
  | { type: "token"; token: string; userEmail?: string };

export function isWorkerRequestMessage(
  data: unknown,
): data is WorkerRequestMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    (data.type === "sync" || data.type === "token") &&
    "token" in data &&
    typeof data.token === "string"
  );
}

// Guard so the module can be imported in node-based unit tests (vitest), where
// `self` does not exist. In a real worker `self` is always defined, so the
// listener registration is unchanged.
if (typeof self !== "undefined") {
  self.addEventListener("message", (e: MessageEvent) => {
    void handleWorkerMessage(e);
  });
}

export async function handleWorkerMessage(e: MessageEvent): Promise<void> {
  // Main-thread "cannot refresh" reply: release any pending 401 wait
  // immediately (resolveTokenRefresh(false) → the sync pass gives up through
  // its normal retry budget). This message carries no token field, so it can
  // never pass the isWorkerRequestMessage guard below and needs its own
  // branch first.
  if (
    typeof e.data === "object" &&
    e.data !== null &&
    (e.data as { type?: unknown }).type === REFRESH_FAILED_TYPE
  ) {
    resolveTokenRefresh(false);
    return;
  }
  if (!isWorkerRequestMessage(e.data)) return;
  const { type, token, userEmail } = e.data;

  if (type === "token") {
    // The email accompanying a rotation needs NO storage: ownership is
    // declared per-run on every "sync" frame (single source of truth), so a
    // mid-run rotation can never split one pass across two owners — the
    // running sync keeps stamping with the email it was started with.
    pushToken(token);
    return;
  }

  await runSync(token, userEmail);
}

export {
  toDriveFileRow,
  toUpsertableFileRow,
  isValidDriveFile,
  partitionValidFiles,
};
export { refreshTokenAndRetry };
export { delay, isTransientStatus, fetchDrive };
export type { SyncRetryState, RefreshTokenRetryDeps };
