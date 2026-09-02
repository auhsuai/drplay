import { db } from "../db/db";
import { upsertFileRows } from "../db/fileRows";
import { getAudioQuery, hasAudioExtension } from "../utils/audioQuery";
import { FOLDER_MIME } from "../utils/driveApi";
import { parseDriveJson } from "./driveFetch";
import type { DriveFile as DriveFileItem } from "./driveMapping";
import { partitionValidFiles } from "./driveMapping";
import { logWorkerError, WorkerAbortError } from "./workerError";
import {
  buildOwnerRow,
  DRIVE_FILES_URL,
  DRIVE_START_PAGE_TOKEN_URL,
  fetchDriveWithAuthRetry,
  FILES_FIELDS,
  hasCurrentToken,
  START_PAGE_TOKEN_KEY,
} from "./syncState";

export async function performFullSync(ownerEmail: string) {
  if (!hasCurrentToken()) return;
  let startToken = "";

  // Start-page token with the shared 401 → refresh → same-URL retry loop.
  // When the budget is exhausted the response is still 401 (SYNC_ERROR
  // already posted by refreshTokenAndRetry) — abort the pass without
  // touching stored state. A non-ok non-401 response falls through to the
  // pagination below with startToken empty (the tail then skips the save).
  try {
    const tokenRes = await fetchDriveWithAuthRetry(
      START_PAGE_TOKEN_KEY,
      "full-sync/startPageToken",
      new URL(DRIVE_START_PAGE_TOKEN_URL),
    );
    if (tokenRes.status === 401) return;
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
      url.searchParams.append("fields", `nextPageToken,files(${FILES_FIELDS})`);
      url.searchParams.append("pageSize", "1000");
      if (pageToken) url.searchParams.append("pageToken", pageToken);

      // Same-page 401 retry lives in fetchDriveWithAuthRetry — the retry
      // never advances pagination (Drive leaves its cursor untouched on 401).
      const res = await fetchDriveWithAuthRetry(
        "files",
        "full-sync/files",
        url,
      );

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
        files?: DriveFileItem[];
        nextPageToken?: string;
      }>("files", res);

      const rawFiles = data.files || [];
      const { valid: validFiles, skippedCount } = partitionValidFiles(rawFiles);
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

      // Canonical-parent rule: parentId is derived INSIDE upsertFileRows
      // from parents[0] of this very response; buildOwnerRow stamps
      // ownerEmail authoritatively.
      const filesToUpsert = validFiles.map((f) =>
        buildOwnerRow(f, f.mimeType === FOLDER_MIME, ownerEmail),
      );

      if (filesToUpsert.length > 0) {
        try {
          await upsertFileRows(filesToUpsert, ownerEmail);
          self.postMessage({ type: "SYNC_PROGRESS" });
        } catch (err) {
          logWorkerError(
            "proSync/full-sync",
            { phase: "upsertFileRows", count: filesToUpsert.length },
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
  //
  // Per-user scoping (schema v10): filesV2 is now keyed [userEmail+id], so
  // the table is shared across accounts and this sweep MUST be scoped to the
  // account being synced — another account's stale-but-real non-playable row
  // belongs to THEIR mirror, and deleting it here would corrupt their library
  // until their own next full sync re-fetches everything. Rows with NO
  // userEmail are deliberately KEPT (undefined never equals ownerEmail):
  // safer to leave an unknown-owner legacy row than to mass-delete rows whose
  // ownership cannot be proven.
  try {
    await db.files
      .filter(
        (f) =>
          f.userEmail === ownerEmail &&
          !f.isFolder &&
          !hasAudioExtension(f.name),
      )
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
