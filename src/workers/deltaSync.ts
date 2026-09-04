import { db } from "../db/db";
import { upsertFileRows } from "../db/fileRows";
import { isAudioFile } from "../utils/audioQuery";
import { FOLDER_MIME } from "../utils/driveApi";
import { parseDriveJson } from "./driveFetch";
import { isValidDriveFile } from "./driveMapping";
import type { DriveChangesList } from "./driveMapping";
import { logWorkerError, WorkerAbortError } from "./workerError";
import {
  buildOwnerRow,
  DRIVE_CHANGES_URL,
  fetchDriveWithAuthRetry,
  FILES_FIELDS,
  hasCurrentToken,
  START_PAGE_TOKEN_KEY,
  syncRetry,
} from "./syncState";
import { performFullSync } from "./fullSync";

export async function performDeltaSync(
  startPageToken: string,
  ownerEmail: string,
) {
  if (!hasCurrentToken()) return;
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

      // Same-page 401 retry lives in fetchDriveWithAuthRetry. The old
      // `continue` only worked by accident: it jumped to `while (pageToken)`,
      // which stayed truthy solely because pageToken === startPageToken on
      // entry. The shared helper makes the same-page retry independent from
      // that truthiness invariant and never advances pagination on a retry
      // (Drive leaves its cursor untouched when it rejects with 401).
      const res = await fetchDriveWithAuthRetry(
        "changes",
        "delta-sync/changes",
        url,
      );

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
          await performFullSync(ownerEmail);
          return;
        }
        // Non-ok with no retry left (refresh refused/failed or a status other
        // than 410/401): report the failure and stop WITHOUT touching stored
        // state. logWorkerError above only records an error-log line, it is
        // NOT a terminal signal — returning here is what makes this exit path
        // honest: no SYNC_COMPLETE, and the save block below never runs, so
        // the stored startPageToken stays put (even when an earlier page of
        // this run already delivered a newStartPageToken) and the next sync
        // replays the exact same window. Breaking silently instead would
        // either advance the cursor past changes we never fetched or leave
        // the poller waiting for a terminal signal that never comes.
        logWorkerError(
          "proSync/delta-sync",
          { phase: "changes", status: res.status },
          new Error(`Failed to fetch changes (${String(res.status)})`),
          "warn",
        );
        self.postMessage({ type: "SYNC_ERROR" });
        return;
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
            // Delete by THIS run's owner key — the compound [userEmail+id]
            // primary key only addresses rows of the account being synced.
            await db.files.delete([ownerEmail, change.fileId as string]);
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
              // Per-change helper call keeps the one-bad-change isolation of
              // the previous per-change put (a batched page-wide upsert would
              // let one poisoned row abort its valid siblings).
              await upsertFileRows(
                [buildOwnerRow(file, isFolder, ownerEmail)],
                ownerEmail,
              );
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
    // Parse/pagination failure mid-run used to end with NO terminal signal at
    // all (the poller kept waiting). Report honestly instead; the stored
    // startPageToken is untouched — the save block above was skipped by the
    // throw — so the next sync replays the same window.
    self.postMessage({ type: "SYNC_ERROR" });
  }
}
