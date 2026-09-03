import { db } from "../db/db";
import { getAudioQuery, hasAudioExtension } from "../utils/audioQuery";
import { FOLDER_MIME } from "../utils/driveApi";
import { partitionValidFiles, toDriveFileRow } from "./driveMapping";
import type { DriveFile } from "./driveMapping";
import { fetchDrive, parseDriveJson } from "./driveFetch";
import { logWorkerError, WorkerAbortError } from "./workerError";
import { refreshTokenAndRetry, syncRetryDeps } from "./tokenRefresh";
import {
  DRIVE_FILES_URL,
  DRIVE_START_PAGE_TOKEN_URL,
  FILES_FIELDS,
  START_PAGE_TOKEN_KEY,
  getCurrentToken,
  syncRetry,
} from "./syncState";

export async function performFullSync() {
  const token = getCurrentToken();
  if (!token) return;
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
        getCurrentToken() as string,
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
    // Set when a mid-pagination failure must be reported honestly instead of
    // falling through to the tail: the tail persists the fresh startPageToken
    // and posts SYNC_COMPLETE, which would brand a partially synced library
    // as complete AND permanently skip the unsynced pages (the next run would
    // delta-sync from the advanced token).
    let filesFailed = false;
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

        // Retry the SAME request after a successful token refresh — Drive
        // rejects the 401 request without advancing its page cursor, so the
        // identical URL (same pageToken) is correct. A bare `continue` here
        // would jump straight to `while (pageToken)` and, when the 401 hit
        // the very first full-sync page (pageToken still undefined), silently
        // end the sync with zero pages fetched yet still report completion.
        let res = await fetchDrive("files", getCurrentToken() as string, url);
        while (!res.ok && res.status === 401) {
          if (
            !(await refreshTokenAndRetry(
              syncRetry,
              syncRetryDeps,
              "full-sync/files",
            ))
          ) {
            break;
          }
          res = await fetchDrive("files", getCurrentToken() as string, url);
        }

        if (!res.ok) {
          // Non-ok with no retry left (refresh refused/failed or a non-401
          // status): flag the failure so the tail guard below reports
          // SYNC_ERROR. logWorkerError above only records an error-log line,
          // it is NOT a terminal signal — breaking without the flag would
          // fall through to the success tail and persist the fresh
          // startPageToken over a partially synced library (permanently
          // skipping the un-fetched pages) AND brand the pass complete.
          logWorkerError(
            "proSync/full-sync",
            { phase: "files", status: res.status },
            new Error(`Failed to fetch files (${String(res.status)})`),
            "warn",
          );
          filesFailed = true;
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
            // Partial failure: stop paginating; the filesFailed guard below
            // reports SYNC_ERROR instead of saving the fresh start token.
            filesFailed = true;
            break;
          }
        }

        pageToken = data.nextPageToken ?? "";
      } while (pageToken);
    } catch (err) {
      if (err instanceof WorkerAbortError) return;
      logWorkerError("proSync/full-sync", { phase: "files" }, err, "error");
      // Parse/pagination failure: partial data must not be reported as a
      // completed sync nor advance the delta cursor (guard below).
      filesFailed = true;
    }

    if (filesFailed) {
      // Exactly one terminal signal per exit path: report the failure and
      // skip the success tail entirely — no startPageToken save, no
      // cleanup, no SYNC_COMPLETE. The next run redoes this pass from the
      // previously stored token.
      self.postMessage({ type: "SYNC_ERROR" });
      return;
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
