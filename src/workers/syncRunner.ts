import { db } from "../db/db";
import { upsertFileRows } from "../db/fileRows";
import {
  getAudioQuery,
  hasAudioExtension,
  isAudioFile,
} from "../utils/audioQuery";
import { FOLDER_MIME } from "../utils/driveApi";
import { DEFAULT_USER_EMAIL } from "../utils/storageKeys";
import {
  isValidDriveFile,
  partitionValidFiles,
  toUpsertableFileRow,
} from "./driveMapping";
import type {
  DriveChangesList,
  DriveFile as DriveFileItem,
} from "./driveMapping";
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

  currentToken = token;
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
  currentToken = token;
  resolveTokenRefresh(true);
}

async function startProSync(ownerEmail: string) {
  if (!currentToken) return;
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

async function performFullSync(ownerEmail: string) {
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
        let res = await fetchDrive("files", currentToken, url);
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
          res = await fetchDrive("files", currentToken, url);
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
          files?: DriveFileItem[];
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

        // Canonical-parent rule: parentId is derived INSIDE upsertFileRows
        // from parents[0] of this very response; the helper stamps
        // ownerEmail authoritatively (the composed userEmail below is the
        // type-required provisional value the helper overwrites).
        const filesToUpsert = validFiles.map((f) => ({
          ...toUpsertableFileRow(f, f.mimeType === FOLDER_MIME),
          userEmail: ownerEmail,
        }));

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

async function performDeltaSync(startPageToken: string, ownerEmail: string) {
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

      // Retry the SAME changes page after a successful token refresh. The old
      // `continue` only worked by accident: it jumped to `while (pageToken)`,
      // which stayed truthy solely because pageToken === startPageToken on
      // entry. The explicit loop makes the same-page retry independent from
      // that truthiness invariant and never advances pagination on a retry
      // (Drive leaves its cursor untouched when it rejects with 401).
      let res = await fetchDrive("changes", currentToken, url);
      while (!res.ok && res.status === 401) {
        if (
          !(await refreshTokenAndRetry(
            syncRetry,
            syncRetryDeps,
            "delta-sync/changes",
          ))
        ) {
          break;
        }
        res = await fetchDrive("changes", currentToken, url);
      }

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
                [
                  {
                    ...toUpsertableFileRow(file, isFolder),
                    userEmail: ownerEmail,
                  },
                ],
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
