import { useEffect } from "react";
import { db } from "../db/db";
import { upsertFileRows, type UpsertableFileRow } from "../db/fileRows";
import { pruneStaleRootRows } from "../db/pruneRootRows";
import { driveFetch, FOLDER_MIME } from "../utils/driveApi";
import type { DriveFileItem, DriveFilesListResponse } from "../utils/driveApi";
import { authHeaders, DRIVE_FILES_URL } from "../utils/driveFiles";
import { getFolderMediaQuery } from "../utils/audioQuery";
import { isPlayableMediaFile } from "../utils/mediaKind";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import {
  DRIVE_FILES_CHANGED_EVENT,
  ROOT_FOLDER_ID,
  VIRTUAL_ROOT_ID,
} from "../utils/driveConstants";
import { getCurrentUserEmail } from "../utils/storageKeys";
import { rememberTotalSizesInServiceWorker } from "../utils/swPrefetch";

const DRIVE_PAGE_SIZE = 1000;

// The root reconcile is DESTRUCTIVE, so every page must be a fully valid
// listing snapshot before any id is trusted: a non-null, non-array object
// whose `files` is an array (the fields mask requests it, so a valid empty
// page carries `files: []`). Anything else — null, arrays, primitives, a
// missing/non-array `files` — is malformed and must never be read as an empty
// authoritative listing.
function isDriveFilesPage(
  value: unknown,
): value is DriveFilesListResponse & { files: DriveFileItem[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (!("files" in value)) return false;
  return Array.isArray(value.files);
}

export function useDriveOnDemandFetch({
  currentFolderId,
  token,
}: {
  currentFolderId: string;
  token: string | null;
}): void {
  const setIsLoadingTracks = useDriveStore((state) => state.setIsLoadingTracks);

  // On-Demand Fetching: Kéo nóng 1 trang từ Drive nếu thư mục chưa có trong Dexie
  useEffect(() => {
    // Virtual root is synthetic (no Drive folder, no Dexie parent) — it must
    // never issue a fetch. Clear the skeleton so the root list paints at once.
    if (currentFolderId === VIRTUAL_ROOT_ID) {
      setIsLoadingTracks(false);
      return;
    }
    if (!token || !currentFolderId || currentFolderId === "") return;

    // Nếu có dữ liệu rồi thì fetch ngầm (không hiện spinner)
    // Nếu chưa có (dbFiles undefined hoặc = 0), hiện spinner.
    let isMounted = true;
    const abortController = new AbortController();
    const stillMounted = () => isMounted;
    const isAborted = () => abortController.signal.aborted;

    const fetchOnDemand = async () => {
      try {
        // B12-2: scope the gate to the current account — another account's
        // rows for the same folder must not suppress the skeleton (compound
        // index [userEmail+parentId], parity with useDriveListing).
        const count = await db.files
          .where("[userEmail+parentId]")
          .equals([getCurrentUserEmail(), currentFolderId])
          .count();
        // B12-4: set both ways. A stale TRUE from a previous (empty) folder
        // survives that run's skipped finally, so a cached folder must be able
        // to clear it instead of showing the skeleton until this fetch settles.
        setIsLoadingTracks(count === 0);

        // Phase A: the folder listing is the audio|video union (not audio-only) —
        // an audio-only query here means browsing a folder that holds movies
        // shows nothing for them, so they can never be selected.
        const q = getFolderMediaQuery(currentFolderId);
        let hasMore = true;
        let pageToken: string | undefined = undefined;
        // Root reconciliation state: every id returned by a COMPLETE listing
        // is valid; any failed page makes the snapshot partial, so it must
        // never drive deletions.
        const ownerEmail = getCurrentUserEmail();
        const seenIds = new Set<string>();
        let listingFailed = false;

        while (hasMore && isMounted && !abortController.signal.aborted) {
          const url = new URL(DRIVE_FILES_URL);
          url.searchParams.set("q", q);
          url.searchParams.set(
            "fields",
            "nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)",
          );
          url.searchParams.set("pageSize", String(DRIVE_PAGE_SIZE));
          if (pageToken) url.searchParams.set("pageToken", pageToken);

          // driveFetch owns the retry policy (driveApi resilience layer):
          // 429/5xx and 403 rate-limit are retried with exponential backoff,
          // honoring Retry-After when present; a caller abort propagates as an
          // immediate rejection (Google handle-errors guidance). A response
          // returned here is final — retried or non-retryable.
          const res = await driveFetch(url.toString(), {
            headers: authHeaders(token),
            signal: abortController.signal,
          });
          if (isAborted()) break;

          if (!res.ok) {
            void captureError({
              level: "warn",
              source: "useDriveExplorer",
              message: `OnDemandFetch Drive API error: HTTP ${String(res.status)} (folder=${currentFolderId})`,
            });
            listingFailed = true;
            break;
          }
          const data = (await res.json()) as unknown;
          if (isAborted()) break;
          if (!isDriveFilesPage(data)) {
            listingFailed = true;
            break;
          }
          const pageFiles = data.files;
          // Prune input is the UNFILTERED page: the reconcile must consider
          // every id Drive returned, including rows the playable-name gate
          // below drops. Otherwise a dropped row would be pruned on listing N
          // and re-fetched on listing N+1, forever.
          for (const f of pageFiles) seenIds.add(f.id);

          // The listing query matches `name contains '.ext'` (substring), so a
          // page can carry names that are not playable files (App.tsx for a
          // future '.ts' scope, photo.avif for '.avi'). Folders always pass;
          // media rows must pass the same endsWith gate every other ingest
          // path applies, so a substring leak never becomes a browse row.
          const playableFiles = pageFiles.filter(
            (f: DriveFileItem) =>
              f.mimeType === FOLDER_MIME || isPlayableMediaFile(f.name),
          );

          // Write each page to Dexie immediately instead of accumulating all
          // pages in memory (mirrors proSync.worker.ts full-sync pattern).
          if (stillMounted() && playableFiles.length > 0) {
            // Canonical-parent rule: parentId is derived INSIDE upsertFileRows
            // from parents[0] of this very response. When Drive omits parents,
            // the listing query ('<folderId>' in parents) itself proves every
            // returned item is a direct child of the folder being listed, so
            // currentFolderId is the verified fallback (knownParents). The
            // row's own parents still wins inside the helper.
            // `parents` is omitted entirely when absent (not set to undefined)
            // because UpsertableFileRow declares it as a plain optional prop.
            // Schema v10: rows carry the owning account — the helper overwrites
            // the composed userEmail with its own ownerEmail argument.
            const rowsToUpsert: UpsertableFileRow[] = playableFiles.map(
              (f: DriveFileItem) => ({
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                ...(f.parents !== undefined ? { parents: f.parents } : {}),
                size: f.size ? parseInt(f.size, 10) : undefined,
                modifiedTime: f.modifiedTime,
                trashed: false,
                isFolder: f.mimeType === FOLDER_MIME,
                userEmail: ownerEmail,
              }),
            );
            try {
              await upsertFileRows(rowsToUpsert, ownerEmail, [currentFolderId]);
            } catch (dbErr) {
              void captureError({
                level: "error",
                source: "useDriveExplorer",
                message: `OnDemandFetch Dexie bulkPut failed (folder=${currentFolderId}, count=${String(rowsToUpsert.length)}): ${String(dbErr)}`,
              });
              listingFailed = true;
              break;
            }
            // Seed the SW's total-size cache from the listing's parsed `size`
            // (REMEMBER_TOTAL_SIZES) so byte-cache serving covers files never
            // streamed yet. Fire-and-forget: listing never waits on it, and a
            // missing controller is a no-op inside the util.
            rememberTotalSizesInServiceWorker(
              rowsToUpsert.flatMap((row) =>
                typeof row.size === "number" &&
                Number.isSafeInteger(row.size) &&
                row.size >= 1
                  ? [{ fileId: row.id, size: row.size }]
                  : [],
              ),
            );
            // Write-through invalidation: this page just landed in the mirror,
            // so HomeTab's Recently Added must refresh now instead of waiting
            // up to the 60s delta-sync poll. Reached only after a successful
            // write (empty page, HTTP/network error, abort and Dexie failure
            // all skip/break above); one event per page is fine — the HomeTab
            // listener collapses bursts with a 1s trailing debounce.
            window.dispatchEvent(
              new CustomEvent(DRIVE_FILES_CHANGED_EVENT, {
                detail: { count: rowsToUpsert.length },
              }),
            );
          }

          pageToken = data.nextPageToken;
          if (!pageToken) hasMore = false;
        }

        // My Drive root is authoritative for everything cached under "root":
        // once EVERY page was fetched and written without a failure, delete
        // cached rows (folders AND media) the listing no longer returns.
        // Non-root folders are never reconciled against the API here.
        if (
          currentFolderId === ROOT_FOLDER_ID &&
          !listingFailed &&
          !isAborted() &&
          stillMounted()
        ) {
          // Fire-and-forget: rows are already written/displayed, and a prune
          // failure is logged by the helper — it never breaks loading.
          void pruneStaleRootRows(ownerEmail, seenIds, {
            foldersOnly: false,
          });
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        if (err instanceof TypeError) {
          void captureError({
            level: "warn",
            source: "useDriveExplorer",
            message: `OnDemandFetch network error (folder=${currentFolderId}): ${err.message}`,
          });
        } else {
          void captureError({
            level: "error",
            source: "useDriveExplorer",
            message: `OnDemandFetch unexpected error (folder=${currentFolderId}): ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } finally {
        if (isMounted) setIsLoadingTracks(false);
      }
    };

    void fetchOnDemand();
    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [currentFolderId, token, setIsLoadingTracks]);
}
