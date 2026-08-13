import { db } from "../db/db";
import {
  getAudioQuery,
  hasAudioExtension,
  isAudioFile,
} from "../utils/audioQuery";
import { FOLDER_MIME } from "../utils/driveApi";
import {
  isValidDriveFile,
  partitionValidFiles,
  toDriveFileRow,
} from "./driveMapping";
import type { DriveChangesList, DriveFile } from "./driveMapping";
import { fetchDrive, parseDriveJson } from "./driveFetch";
import {
  refreshTokenAndRetry,
  resolveTokenRefresh,
  syncRetryDeps,
} from "./tokenRefresh";
import { logWorkerError, WorkerAbortError } from "./workerError";

let isBusy = false;
let currentToken: string | null = null;
const MAX_SYNC_RETRIES = 3;
const syncRetry = { count: 0, max: MAX_SYNC_RETRIES };

// Dexie syncState key holding the Drive changes start-page token.
const START_PAGE_TOKEN_KEY = "startPageToken";

// Drive API v3 endpoints — base + derived names (values byte-identical to the
// historical literals; DRIVE_FILES_URL mirrors src/utils/driveFiles.ts).
const DRIVE_SYNC_URL = "https://www.googleapis.com/drive/v3";
const DRIVE_FILES_URL = `${DRIVE_SYNC_URL}/files`;
const DRIVE_CHANGES_URL = `${DRIVE_SYNC_URL}/changes`;
const DRIVE_START_PAGE_TOKEN_URL = `${DRIVE_CHANGES_URL}/startPageToken`;

// File projection shared by the files-list and changes fields parameters.
const FILES_FIELDS = "id,name,mimeType,parents,size,modifiedTime";

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

  currentToken = token;
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
  currentToken = token;
  resolveTokenRefresh(true);
}

async function startProSync() {
  if (!currentToken) return;
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

async function performFullSync() {
  if (!currentToken) return;
  let startToken = "";

  // Retry the whole pass only when the startPageToken fetch hits 401 and the
  // main thread successfully refreshes the token.
  let retryFullSync = true;
  while (retryFullSync) {
    retryFullSync = false;

    try {
      const tokenUrl = new URL(DRIVE_START_PAGE_TOKEN_URL);
      const tokenRes = await fetchDrive(
        START_PAGE_TOKEN_KEY,
        currentToken,
        tokenUrl,
      );

      if (tokenRes.status === 401) {
        if (
          !(await refreshTokenAndRetry(
            syncRetry,
            syncRetryDeps,
            "full-sync/startPageToken",
          ))
        )
          return;
        retryFullSync = true;
        continue;
      }
      if (tokenRes.ok) {
        const tokenData = await parseDriveJson<{ startPageToken: string }>(
          START_PAGE_TOKEN_KEY,
          tokenRes,
        );
        startToken = tokenData.startPageToken;
      }
    } catch (err) {
      if (err instanceof WorkerAbortError) return;
      logWorkerError(
        "proSync/full-sync",
        { phase: START_PAGE_TOKEN_KEY },
        err,
        "error",
      );
      return;
    }

    let pageToken: string | undefined = undefined;
    try {
      do {
        const url = new URL(DRIVE_FILES_URL);
        url.searchParams.append("q", getAudioQuery());
        url.searchParams.append(
          "fields",
          `nextPageToken,files(${FILES_FIELDS})`,
        );
        url.searchParams.append("pageSize", "1000");
        if (pageToken) url.searchParams.append("pageToken", pageToken);

        const res = await fetchDrive("files", currentToken, url);

        if (!res.ok) {
          if (res.status === 401) {
            if (
              await refreshTokenAndRetry(
                syncRetry,
                syncRetryDeps,
                "full-sync/files",
              )
            )
              continue;
          }
          // Non-ok with no retry left (refresh refused/failed or a non-401
          // status): say so instead of breaking silently — the poller would
          // otherwise wait for a SYNC_COMPLETE that never comes.
          logWorkerError(
            "proSync/full-sync",
            { phase: "files", status: res.status },
            new Error(`Failed to fetch files (${String(res.status)})`),
            "warn",
          );
          break;
        }

        const data = await parseDriveJson<{
          files?: DriveFile[];
          nextPageToken?: string;
        }>("files", res);

        const rawFiles = data.files || [];
        const { valid: validFiles, skippedCount } =
          partitionValidFiles(rawFiles);
        // A page with unpersistable files is not a failure of this sync pass,
        // but dropping them silently hides data-loss from the user; emit one
        // summary line per page instead of spamming one line per file.
        if (skippedCount > 0) {
          logWorkerError(
            "proSync/full-sync/files",
            { kind: "skip", skippedCount, total: rawFiles.length },
            new Error(`${String(skippedCount)} file(s) skipped: missing id`),
            "warn",
          );
        }

        const filesToInsert = validFiles.map((f) =>
          toDriveFileRow(f, f.mimeType === FOLDER_MIME),
        );

        if (filesToInsert.length > 0) {
          try {
            await db.files.bulkPut(filesToInsert);
            self.postMessage({ type: "SYNC_PROGRESS" });
          } catch (err) {
            logWorkerError(
              "proSync/full-sync",
              { phase: "bulkPut", count: filesToInsert.length },
              err,
              "error",
            );
            break;
          }
        }

        pageToken = data.nextPageToken ?? "";
      } while (pageToken);
    } catch (err) {
      if (err instanceof WorkerAbortError) return;
      logWorkerError("proSync/full-sync", { phase: "files" }, err, "error");
    }
  }

  if (startToken) {
    try {
      await db.syncState.put({ key: START_PAGE_TOKEN_KEY, value: startToken });
    } catch (err) {
      logWorkerError(
        "proSync/full-sync",
        { phase: "saveStartToken" },
        err,
        "error",
      );
    }
  }

  // One-time cleanup (Task 1 — hide-unplayable-formats): rows synced before
  // this change may hold formats Chromium/WebView2 cannot decode
  // (wma/aiff/alac/ape/dsf/dff/wv/tak). Delete every non-folder row whose
  // name has no playable extension (folders keep their rows — isFolder
  // exempts them even though their names have no audio extension). Runs only
  // at full-sync completion (delta sync never mass-deletes) and is
  // best-effort: a cleanup failure must not fail the whole sync.
  try {
    await db.files
      .filter((f) => !f.isFolder && !hasAudioExtension(f.name))
      .delete();
  } catch (err) {
    logWorkerError(
      "proSync/full-sync",
      { phase: "cleanupNonPlayable" },
      err,
      "warn",
    );
  }

  self.postMessage({ type: "SYNC_COMPLETE" });
}

async function performDeltaSync(startPageToken: string) {
  if (!currentToken) return;
  let pageToken = startPageToken;
  let newStartPageToken = startPageToken;
  // Files skipped because they lack a usable id, accumulated across all pages
  // of this delta run and reported as one summary line at the end.
  let skippedDeltaFiles = 0;

  try {
    do {
      const url = new URL(DRIVE_CHANGES_URL);
      url.searchParams.append("pageToken", pageToken);
      url.searchParams.append(
        "fields",
        `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILES_FIELDS},trashed))`,
      );

      const res = await fetchDrive("changes", currentToken, url);

      if (!res.ok) {
        if (res.status === 410) {
          syncRetry.count = 0;
          try {
            await db.syncState.delete(START_PAGE_TOKEN_KEY);
          } catch (err) {
            logWorkerError(
              "proSync/delta-sync",
              { phase: "deleteStartToken" },
              err,
              "error",
            );
          }
          await performFullSync();
          return;
        }
        if (res.status === 401) {
          if (
            await refreshTokenAndRetry(
              syncRetry,
              syncRetryDeps,
              "delta-sync/changes",
            )
          )
            continue;
        }
        // Non-ok with no retry left (refresh refused/failed or a status other
        // than 410/401): say so instead of breaking silently — the poller
        // would otherwise wait for a SYNC_COMPLETE that never comes.
        logWorkerError(
          "proSync/delta-sync",
          { phase: "changes", status: res.status },
          new Error(`Failed to fetch changes (${String(res.status)})`),
          "warn",
        );
        break;
      }

      const data = await parseDriveJson<DriveChangesList>("changes", res);

      const changes = data.changes || [];
      let hasValidChanges = false;

      for (const change of changes) {
        try {
          if (change.removed || (change.file && change.file.trashed)) {
            // The Drive changes API always reports fileId for removed entries;
            // the explicit assertion mirrors the previous `!` with identical
            // runtime semantics (a missing fileId still throws inside the
            // per-change try/catch below).
            await db.files.delete(change.fileId as string);
            hasValidChanges = true;
          } else if (change.file) {
            const file = change.file;
            // A change whose file lacks an id cannot be persisted; skip it
            // (per-change isolation, matching the try/catch below). The count
            // is accumulated across pages and reported in one summary line
            // after the pagination loop.
            if (!isValidDriveFile(file)) {
              skippedDeltaFiles += 1;
              continue;
            }
            const isFolder = file.mimeType === FOLDER_MIME;

            if (isFolder || isAudioFile(file.mimeType, file.name as string)) {
              await db.files.put(toDriveFileRow(file, isFolder));
              hasValidChanges = true;
            }
          }
        } catch (err) {
          // One bad change must not abort the whole delta batch.
          logWorkerError(
            "proSync/delta-sync",
            { phase: "applyChange", fileId: change.fileId },
            err,
            "error",
          );
        }
      }

      if (data.newStartPageToken) {
        newStartPageToken = data.newStartPageToken;
      }
      pageToken = data.nextPageToken ?? "";

      if (hasValidChanges) {
        self.postMessage({ type: "SYNC_PROGRESS" });
      }
    } while (pageToken);

    // One summary line per delta run (not per skipped file) so a library with
    // missing-id files is never silently incomplete.
    if (skippedDeltaFiles > 0) {
      logWorkerError(
        "proSync/delta-sync/changes",
        { kind: "skip", skippedCount: skippedDeltaFiles },
        new Error(`${String(skippedDeltaFiles)} file(s) skipped: missing id`),
        "warn",
      );
    }

    if (newStartPageToken !== startPageToken) {
      try {
        await db.syncState.put({
          key: START_PAGE_TOKEN_KEY,
          value: newStartPageToken,
        });
      } catch (err) {
        logWorkerError(
          "proSync/delta-sync",
          { phase: "saveStartToken" },
          err,
          "error",
        );
      }
      self.postMessage({ type: "SYNC_COMPLETE" });
    }
  } catch (err) {
    if (err instanceof WorkerAbortError) return;
    logWorkerError("proSync/delta-sync", { phase: "changes" }, err, "error");
  }
}
