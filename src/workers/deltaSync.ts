import { db } from "../db/db";
import { upsertFileRows } from "../db/fileRows";
import { isPlayableMediaFile } from "../utils/mediaKind";
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
  // Changes whose row was DELIBERATELY not written because no source proved its
  // parent (see fileRows.canonicalParent — no fake parent, no root fallback).
  // This is an intentional skip, NOT a failure: it must not set changesFailed,
  // because a parentless change is deterministically parentless, so replaying
  // the window would re-deliver the same file and the cursor would never
  // advance (a permanent delta stall). It IS reported, once per run, so a
  // consumed-but-unwritten change is never invisible.
  let skippedParentlessChanges = 0;
  // Set when at least one change of this run could NOT be applied to the
  // mirror (malformed removal, file missing a usable name, or a Dexie
  // failure). The cursor must never advance past such a change: a failed run
  // neither saves newStartPageToken nor reports SYNC_COMPLETE, so the next
  // poll replays this exact window (the writes are idempotent by primary key).
  let changesFailed = false;
  // How many changes were left unapplied — reported as ONE summary line with
  // counts only (no tokens, no file metadata beyond the ids already logged).
  let unappliedChanges = 0;

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
            // Drive always reports fileId for removed entries; a removal with
            // no usable id cannot be applied at all. Classify it as
            // malformed/unapplied (never a silent no-op) so the cursor stays
            // behind it instead of stepping over an undeleted row.
            const removedId = change.fileId;
            if (typeof removedId !== "string" || removedId.length === 0) {
              changesFailed = true;
              unappliedChanges += 1;
              logWorkerError(
                "proSync/delta-sync",
                {
                  phase: "applyChange",
                  kind: "malformed-removal",
                  fileId: change.fileId,
                },
                new Error("removal change has no usable fileId"),
                "error",
              );
              continue;
            }
            // Delete by THIS run's owner key — the compound [userEmail+id]
            // primary key only addresses rows of the account being synced.
            await db.files.delete([ownerEmail, removedId]);
            hasValidChanges = true;
          } else if (change.file) {
            const file = change.file;
            // A change whose file lacks an id cannot be persisted; the run
            // cannot apply it, so it is counted AND blocks the cursor (the
            // count alone would let the checkpoint advance past it).
            if (!isValidDriveFile(file)) {
              skippedDeltaFiles += 1;
              changesFailed = true;
              unappliedChanges += 1;
              continue;
            }
            // `name` drives the "is this playable" classification: without it
            // the change cannot be applied at all. It must NOT be treated as
            // "unsupported" — deleting a row on an unclassifiable change would
            // silently drop a real library entry.
            if (typeof file.name !== "string" || file.name.length === 0) {
              changesFailed = true;
              unappliedChanges += 1;
              logWorkerError(
                "proSync/delta-sync",
                {
                  phase: "applyChange",
                  kind: "missing-name",
                  fileId: file.id,
                },
                new Error("change file has no usable name"),
                "error",
              );
              continue;
            }
            // `mimeType` is optional on DriveFile: a change can arrive without
            // it. Classification (folder / playable / unsupported) rests on it,
            // and the unsupported branch DELETES the mirror row — so an absent
            // type plus a non-playable name would drop a real entry on metadata
            // that cannot establish the kind. Treat it as unapplied instead.
            // This is a delta-only precondition: Full Sync's page path keeps
            // isValidDriveFile/partitionValidFiles untouched (a full page is
            // authoritative for what exists, a delta must not infer absence).
            if (
              typeof file.mimeType !== "string" ||
              file.mimeType.trim().length === 0
            ) {
              changesFailed = true;
              unappliedChanges += 1;
              logWorkerError(
                "proSync/delta-sync",
                {
                  phase: "applyChange",
                  kind: "missing-mime",
                  fileId: file.id,
                },
                new Error("change file has no usable mimeType"),
                "error",
              );
              continue;
            }
            const isFolder = file.mimeType === FOLDER_MIME;

            // Phase A: the mirror holds BOTH kinds (the full-sync query is the
            // audio|video union), so this gate must accept a playable video
            // file too. An audio-only predicate here would drop every .mkv /
            // .mp4 change from Drive — movies would appear after a full sync
            // and then never update, rename or delete in place.
            if (isFolder || isPlayableMediaFile(file.name)) {
              // Per-change helper call keeps the one-bad-change isolation of
              // the previous per-change put (a batched page-wide upsert would
              // let one poisoned row abort its valid siblings).
              // The result is inspected only for telemetry: the change IS
              // consumed either way, so hasValidChanges stays true below.
              const { skippedParentlessCount } = await upsertFileRows(
                [buildOwnerRow(file, isFolder, ownerEmail)],
                ownerEmail,
              );
              skippedParentlessChanges += skippedParentlessCount;
              hasValidChanges = true;
            } else {
              // Unsupported (non-folder, non-playable) — e.g. an mp3 renamed
              // to .txt/.pdf — must not stay in the mirror: without this
              // branch the stale row survived forever and kept showing up in
              // the explorer and in search. Delete by the compound key only,
              // so another account's row with the same Drive id is untouched.
              // A missing row is a successful no-op (Dexie delete resolves).
              await db.files.delete([ownerEmail, file.id]);
              hasValidChanges = true;
            }
          }
        } catch (err) {
          // One bad change must not abort the whole delta batch, but it MUST
          // block the checkpoint: continuing the loop with the flag set keeps
          // the remaining changes applied while guaranteeing this window is
          // replayed on the next run.
          changesFailed = true;
          unappliedChanges += 1;
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

    // One aggregate line per run for the intentional parentless skip. Level
    // warn, not error: the run SUCCEEDS (checkpoint below still advances and
    // SYNC_COMPLETE is still posted) — the marker exists so "consumed" can
    // never be read as "indexed". Counts only, no ids or tokens.
    if (skippedParentlessChanges > 0) {
      logWorkerError(
        "proSync/delta-sync/changes",
        {
          kind: "parentless-skip",
          skippedParentlessCount: skippedParentlessChanges,
        },
        new Error(
          `${String(skippedParentlessChanges)} change(s) skipped: no provable parent (not indexed)`,
        ),
        "warn",
      );
    }

    // A run with at least one unapplied change is NOT a completed run: the
    // cursor must not step over it. Report exactly one terminal signal and
    // return BEFORE the checkpoint save, so the stored startPageToken keeps
    // pointing at this window and the next poll replays it (applied changes
    // are idempotent by primary key; the failed ones get another chance).
    if (changesFailed) {
      logWorkerError(
        "proSync/delta-sync/changes",
        { kind: "unapplied", unappliedCount: unappliedChanges },
        new Error(
          `${String(unappliedChanges)} change(s) not applied: cursor not advanced`,
        ),
        "error",
      );
      self.postMessage({ type: "SYNC_ERROR" });
      return;
    }

    // No-change run: Drive returned the same startPageToken and nothing to
    // persist. This is a SUCCESSFUL, fully terminated run — it used to post no
    // terminal event at all, leaving the poller waiting forever. Post the one
    // COMPLETE it owes the main thread, and do not save.
    if (newStartPageToken === startPageToken) {
      self.postMessage({ type: "SYNC_COMPLETE" });
      return;
    }

    // Checkpoint persistence is part of the run's success: if the token
    // cannot be stored, the main thread must not be told the run completed
    // (it would then believe this window is consumed while the next poll
    // replays it).
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
      self.postMessage({ type: "SYNC_ERROR" });
      return;
    }
    self.postMessage({ type: "SYNC_COMPLETE" });
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
