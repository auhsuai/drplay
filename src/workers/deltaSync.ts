import { db } from "../db/db";
import { isAudioFile } from "../utils/audioQuery";
import { FOLDER_MIME } from "../utils/driveApi";
import { isValidDriveFile, toDriveFileRow } from "./driveMapping";
import type { DriveChangesList } from "./driveMapping";
import { fetchDrive, parseDriveJson } from "./driveFetch";
import { logWorkerError, WorkerAbortError } from "./workerError";
import { refreshTokenAndRetry, syncRetryDeps } from "./tokenRefresh";
import {
  DRIVE_CHANGES_URL,
  FILES_FIELDS,
  START_PAGE_TOKEN_KEY,
  getCurrentToken,
  syncRetry,
} from "./syncState";
import { performFullSync } from "./fullSync";

export async function performDeltaSync(startPageToken: string) {
  const token = getCurrentToken();
  if (!token) return;
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

      const res = await fetchDrive("changes", getCurrentToken() as string, url);

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
