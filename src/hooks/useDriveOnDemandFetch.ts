import { useEffect } from "react";
import { db } from "../db/db";
import { driveFetch } from "../utils/driveApi";
import type { DriveFileItem, DriveFilesListResponse } from "../utils/driveApi";
import { getFolderAudioQuery } from "../utils/audioQuery";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_PAGE_SIZE = 1000;

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
    if (!token || !currentFolderId || currentFolderId === "") return;

    // Nếu có dữ liệu rồi thì fetch ngầm (không hiện spinner)
    // Nếu chưa có (dbFiles undefined hoặc = 0), hiện spinner.
    let isMounted = true;
    const abortController = new AbortController();
    const stillMounted = () => isMounted;
    const isAborted = () => abortController.signal.aborted;

    const fetchOnDemand = async () => {
      try {
        const count = await db.files
          .where("parentId")
          .equals(currentFolderId)
          .count();
        if (count === 0) setIsLoadingTracks(true);

        const q = getFolderAudioQuery(currentFolderId);
        let hasMore = true;
        let pageToken: string | undefined = undefined;

        while (hasMore && isMounted && !abortController.signal.aborted) {
          const url = new URL("https://www.googleapis.com/drive/v3/files");
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
            headers: { Authorization: `Bearer ${token}` },
            signal: abortController.signal,
          });
          if (isAborted()) break;

          if (!res.ok) {
            void captureError({
              level: "warn",
              source: "useDriveExplorer",
              message: `OnDemandFetch Drive API error: HTTP ${String(res.status)} (folder=${currentFolderId})`,
            });
            break;
          }
          const data = (await res.json()) as DriveFilesListResponse | null;
          if (isAborted()) break;

          // Write each page to Dexie immediately instead of accumulating all
          // pages in memory (mirrors proSync.worker.ts full-sync pattern).
          if (
            stillMounted() &&
            data &&
            Array.isArray(data.files) &&
            data.files.length > 0
          ) {
            const filesToInsert = data.files.map((f: DriveFileItem) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              parentId: currentFolderId,
              size: f.size ? parseInt(f.size, 10) : undefined,
              modifiedTime: f.modifiedTime,
              trashed: false,
              isFolder: f.mimeType === GOOGLE_FOLDER_MIME,
            }));
            try {
              await db.files.bulkPut(filesToInsert);
            } catch (dbErr) {
              void captureError({
                level: "error",
                source: "useDriveExplorer",
                message: `OnDemandFetch Dexie bulkPut failed (folder=${currentFolderId}, count=${String(filesToInsert.length)}): ${String(dbErr)}`,
              });
              break;
            }
          }

          pageToken = data?.nextPageToken;
          if (!pageToken) hasMore = false;
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
