import { db } from "../db/db";
import { upsertFileRows } from "../db/fileRows";
import { getMediaQuery } from "../utils/audioQuery";
import { isPlayableMediaFile } from "../utils/mediaKind";
import { FOLDER_MIME } from "../utils/driveApi";
import { parseDriveJson } from "./driveFetch";
import type { DriveFile as DriveFileItem } from "./driveMapping";
import { partitionClassifiableFiles } from "./driveMapping";
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
  // The caller owns the terminal signal (B18-4): a 401 that survives the
  // refresh/retry flow — budget exhausted or refresh failed — aborts the pass
  // with SYNC_ERROR below without touching stored state. A non-ok non-401
  // response falls through to the pagination below with startToken empty (the
  // tail then skips the save).
  try {
    const tokenRes = await fetchDriveWithAuthRetry(
      START_PAGE_TOKEN_KEY,
      "full-sync/startPageToken",
      new URL(DRIVE_START_PAGE_TOKEN_URL),
    );
    if (tokenRes.status === 401) {
      self.postMessage({ type: "SYNC_ERROR" });
      return;
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
    // Network/parse failure before any page was fetched: report exactly one
    // honest terminal signal (the pass cannot proceed past the token phase).
    self.postMessage({ type: "SYNC_ERROR" });
    return;
  }

  let pageToken: string | undefined = undefined;
  // Set when a mid-pagination failure must be reported honestly instead of
  // falling through to the tail: the tail persists the fresh startPageToken
  // and posts SYNC_COMPLETE, which would brand a partially synced library
  // as complete AND permanently skip the unsynced pages (the next run would
  // delta-sync from the advanced token).
  let filesFailed = false;
  // Ids seen on this pass whose name/mimeType could not classify the item
  // (missing id-valid resource metadata). They are never written, and the
  // cleanup sweep below must not delete them either: a malformed folder whose
  // row was previously mislabeled `isFolder:false` has no playable extension,
  // so a sweep that ignored this set would delete a real folder and orphan its
  // whole subtree (search is fail-closed on orphans).
  const unclassifiableIds = new Set<string>();
  try {
    do {
      const url = new URL(DRIVE_FILES_URL);
      url.searchParams.append("q", getMediaQuery());
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
      // Classification precondition: a row is only ever built from a resource
      // whose name AND mimeType are usable. Without this, an absent/blank
      // mimeType defaults `isFolder` to false and the completion sweep deletes
      // the row as unsupported media (its name has no playable extension).
      // `skippedCount` keeps its historical "missing id" meaning so the log
      // below stays accurate.
      const {
        valid: validFiles,
        skippedCount,
        unclassifiable,
      } = partitionClassifiableFiles(rawFiles);
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

      // One aggregate line per page for the unclassifiable bucket. NOT a
      // failure: full sync keeps no cursor that could be protected (the next
      // pass re-lists everything), and failing every pass would leave the
      // library permanently unindexed. The ids are remembered so the sweep
      // below never deletes one of these rows.
      if (unclassifiable.length > 0) {
        for (const f of unclassifiable) unclassifiableIds.add(f.id);
        logWorkerError(
          "proSync/full-sync/files",
          {
            kind: "unclassifiable",
            count: unclassifiable.length,
            total: rawFiles.length,
          },
          new Error(
            `${String(unclassifiable.length)} file(s) skipped: unusable name/mimeType`,
          ),
          "warn",
        );
      }

      // Canonical-parent rule: parentId is derived INSIDE upsertFileRows
      // from parents[0] of this very response; buildOwnerRow stamps
      // ownerEmail authoritatively. Only classifiable resources reach this
      // map, so `isFolder` is never defaulted from a missing mimeType.
      const filesToUpsert = validFiles.map((f) =>
        buildOwnerRow(f, f.mimeType === FOLDER_MIME, ownerEmail),
      );

      if (filesToUpsert.length > 0) {
        try {
          const { skippedParentlessCount } = await upsertFileRows(
            filesToUpsert,
            ownerEmail,
          );
          // Telemetry only: a parentless row is an intentional skip (it stays
          // out of db.files and therefore out of search), never a page failure.
          // The next pass re-lists with parents, so this self-heals.
          if (skippedParentlessCount > 0) {
            logWorkerError(
              "proSync/full-sync/files",
              {
                kind: "parentless-skip",
                skippedParentlessCount,
                total: filesToUpsert.length,
              },
              new Error(
                `${String(skippedParentlessCount)} file(s) skipped: no provable parent (not indexed)`,
              ),
              "warn",
            );
          }
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
    // Checkpoint persistence is PART of the pass's success: if the fresh
    // startPageToken cannot be stored, the pass must not be branded complete
    // (the next delta run would then re-consume a window this pass already
    // applied) and the cleanup sweep must not run on a pass whose checkpoint
    // is unrecorded. Report one terminal signal and stop here.
    try {
      await db.syncState.put({ key: START_PAGE_TOKEN_KEY, value: startToken });
    } catch (err) {
      logWorkerError(
        "proSync/full-sync",
        { phase: "saveStartToken" },
        err,
        "error",
      );
      self.postMessage({ type: "SYNC_ERROR" });
      return;
    }
  }

  // One-time cleanup (Task 1 — hide-unplayable-formats): rows synced before
  // this change may hold containers the shipped engine has never been verified
  // against end to end (alac/ape/dsf/dff/wv/tak). Delete every non-folder row
  // whose name has no playable extension (folders keep their rows — isFolder
  // exempts them even though their names have no media extension). Runs only
  // at full-sync completion (delta sync never mass-deletes) and is
  // best-effort: a cleanup failure must not fail the whole sync.
  //
  // Phase A: "playable" is now BOTH kinds — isPlayableMediaFile, not
  // hasAudioExtension. An audio-only predicate here would delete every .mkv /
  // .mp4 row the union query above just inserted, so the library would appear
  // and then silently self-empty on every full sync.
  //
  // Per-user scoping (schema v10): filesV2 is now keyed [userEmail+id], so
  // the table is shared across accounts and this sweep MUST be scoped to the
  // account being synced — another account's stale-but-real non-playable row
  // belongs to THEIR mirror, and deleting it here would corrupt their library
  // until their own next full sync re-fetches everything. Rows with NO
  // userEmail are deliberately KEPT (undefined never equals ownerEmail):
  // safer to leave an unknown-owner legacy row than to mass-delete rows whose
  // ownership cannot be proven.
  //
  // S-02: ids this pass could not classify are excluded. Such a file has no
  // trustworthy `isFolder`, so a row already stored for it (e.g. a folder
  // written before the classification precondition existed) is exempt: its
  // name has no playable extension, so the sweep would delete a real folder
  // and orphan its whole subtree. A cleanup failure must not fake a successful
  // sweep — the catch below still logs it (unchanged).
  try {
    await db.files
      .filter(
        (f) =>
          f.userEmail === ownerEmail &&
          !unclassifiableIds.has(f.id) &&
          !f.isFolder &&
          !isPlayableMediaFile(f.name),
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
