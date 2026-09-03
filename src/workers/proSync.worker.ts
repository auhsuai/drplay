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
} from "./driveMapping";

type WorkerRequestMessage =
  { type: "sync"; token: string } | { type: "token"; token: string };

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
  const { type, token } = e.data;

  if (type === "token") {
    pushToken(token);
    return;
  }

  await runSync(token);
}

export { toDriveFileRow, isValidDriveFile, partitionValidFiles };
export { refreshTokenAndRetry };
export { delay, isTransientStatus, fetchDrive };
export type { SyncRetryState, RefreshTokenRetryDeps };
