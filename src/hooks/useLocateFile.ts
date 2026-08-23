import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { db } from "../db/db";
import { classifyDriveError } from "../utils/driveApi";
import {
  ROOT_FOLDER_ID,
  MY_DRIVE_TAB,
  type TabKey,
} from "../utils/driveConstants";
import { captureError } from "../utils/errorLog";
import { getFileName, getFileParents } from "../utils/driveFiles";
import { ROOT_FOLDER_KEY as STORAGE_KEY_ROOT } from "../utils/storageKeys";

const HISTORY_LIMIT = 20;
const HIGHLIGHT_DURATION_MS = 5000;
const DRIVE_ID_PREFIX = "drive_";
const EVENT_LOCATE_FILE = "locate-file";
// Kept as the fallback for t('drive.unknown_folder'): the breadcrumb name is
// computed inside an async event handler, and the English default guarantees a
// readable label even if a locale key is missing.
const UNKNOWN_FOLDER = "Unknown Folder";

// localStorage can throw (privacy mode / disabled storage) — a failed root
// read must never crash the locate flow; fall back to the Drive root.
function readStoredRootFolder(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_ROOT);
  } catch {
    void captureError({
      level: "warn",
      source: "useLocateFile",
      message: "locate-root-read-failed",
    });
    return null;
  }
}

export function useLocateFile(
  accessToken: string | null,
  currentFolderId: string,
  setCurrentFolderId: (id: string) => void,
  setCurrentFolderName: (name: string) => void,
  setFolderHistory: (history: { id: string; name: string }[]) => void,
  setActiveTab: (tab: TabKey) => void,
  setIsLoadingTracks: (loading: boolean) => void,
) {
  const { t } = useTranslation();
  const [highlightedFileId, setHighlightedFileId] = useState<{
    id: string;
    ts: number;
    folderId: string;
  } | null>(null);
  const pendingEnsuredFileId = useRef<string | null>(null);
  const locateInFlightRef = useRef(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let mounted = true;
    const stillMounted = () => mounted;
    // F5: one controller per effect run — cleanup aborts it so an in-flight
    // locate chain (up to ~42 sequential Drive fetches) cannot outlive the
    // listener that started it.
    const abortController = new AbortController();
    const { signal } = abortController;
    // Intentional cancel (unmount / deps change): mirror driveHttp's
    // caller-abort guard — exit fast and quiet instead of logging a failure.
    const isCallerAborted = (err: unknown): boolean =>
      signal.aborted ||
      (err instanceof DOMException && err.name === "AbortError");
    const handleLocateFile = async (ev: Event) => {
      if (locateInFlightRef.current) return;
      // Duck-typed event payload: locate-file is dispatched internally with
      // { fileId }, but a corrupt/malformed event must not crash the listener.
      const detail = (ev as CustomEvent<{ fileId?: unknown } | null>).detail;
      const rawFileId = detail?.fileId;
      if (typeof rawFileId !== "string" || !rawFileId || !accessToken) return;
      let fileId: string = rawFileId;

      if (fileId.startsWith(DRIVE_ID_PREFIX)) {
        fileId = fileId.replace(DRIVE_ID_PREFIX, "");
      }

      const rebuildHistory = async (
        targetFolderId: string,
      ): Promise<{ id: string; name: string }[]> => {
        const rootRaw = readStoredRootFolder();
        const rootId = rootRaw || ROOT_FOLDER_ID;

        let current = targetFolderId;
        const newHistory: { id: string; name: string }[] = [];
        let limit = HISTORY_LIMIT;

        while (current !== rootId && current !== ROOT_FOLDER_ID && limit > 0) {
          limit--;

          let pId: string | undefined;
          const folderInfo = await db.files.get(current);

          if (!folderInfo || !folderInfo.parentId) {
            try {
              const parents = await getFileParents(
                accessToken,
                current,
                signal,
              );
              pId = parents?.[0];
            } catch (e: unknown) {
              if (isCallerAborted(e)) throw e;
              void captureError({
                level: "warn",
                source: "useLocateFile",
                message: `Failed to get parents via API: ${classifyDriveError(e)}`,
              });
            }
            if (!pId) break;
          } else {
            pId = folderInfo.parentId;
          }

          if (pId === rootId || pId === ROOT_FOLDER_ID) {
            newHistory.unshift({ id: pId, name: MY_DRIVE_TAB });
            break;
          }

          const parentInfo = await db.files.get(pId);
          if (!parentInfo) {
            try {
              const parentName = await getFileName(accessToken, pId, signal);
              newHistory.unshift({
                id: pId,
                name: parentName ?? t("drive.unknown_folder", UNKNOWN_FOLDER),
              });
            } catch (e: unknown) {
              if (isCallerAborted(e)) throw e;
              void captureError({
                level: "warn",
                source: "useLocateFile",
                message: `Parent name fetch failed: ${classifyDriveError(e)}`,
              });
              newHistory.unshift({
                id: pId,
                name: t("drive.unknown_folder", UNKNOWN_FOLDER),
              });
            }
          } else {
            newHistory.unshift({ id: parentInfo.id, name: parentInfo.name });
          }
          current = pId;
        }
        return newHistory;
      };

      const clearHighlightTimer = () => {
        if (highlightTimerRef.current !== null) {
          clearTimeout(highlightTimerRef.current);
          highlightTimerRef.current = null;
        }
      };

      const scheduleHighlightClear = () => {
        clearHighlightTimer();
        highlightTimerRef.current = setTimeout(() => {
          highlightTimerRef.current = null;
          setHighlightedFileId(null);
        }, HIGHLIGHT_DURATION_MS);
      };

      locateInFlightRef.current = true;
      setIsLoadingTracks(true);
      setActiveTab(MY_DRIVE_TAB);

      try {
        let parentId: string | null = null;
        let folderName = t("drive.unknown_folder", UNKNOWN_FOLDER);

        try {
          const parents = await getFileParents(accessToken, fileId, signal);
          if (!stillMounted()) return;
          const first = parents?.[0];
          if (first !== undefined) parentId = first;
        } catch (e: unknown) {
          if (isCallerAborted(e)) throw e;
          void captureError({
            level: "warn",
            source: "useLocateFile",
            message: `Locate parent API failed: ${classifyDriveError(e)}`,
          });
        }

        if (!parentId) {
          const fileInfo = await db.files.get(fileId);
          if (!mounted) return;
          if (fileInfo && fileInfo.parentId) {
            parentId = fileInfo.parentId;
          }
        }

        if (!parentId) throw new Error("Could not determine parent folder");

        const rootRaw = readStoredRootFolder();
        const rootId = rootRaw || ROOT_FOLDER_ID;

        if (parentId === rootId || parentId === ROOT_FOLDER_ID) {
          folderName = MY_DRIVE_TAB;
        } else {
          const parentInfo = await db.files.get(parentId);
          if (!mounted) return;
          if (parentInfo) {
            folderName = parentInfo.name;
          } else {
            // F4: a cosmetic name lookup must not kill the whole locate —
            // mirror rebuildHistory's degrade contract (warn + Unknown Folder
            // fallback), so navigation still completes.
            try {
              const fetchedName = await getFileName(
                accessToken,
                parentId,
                signal,
              );
              if (!stillMounted()) return;
              if (fetchedName !== null) folderName = fetchedName;
            } catch (e: unknown) {
              if (isCallerAborted(e)) throw e;
              void captureError({
                level: "warn",
                source: "useLocateFile",
                message: `Parent name fetch failed: ${classifyDriveError(e)}`,
              });
            }
          }
        }

        if (parentId === currentFolderId) {
          setHighlightedFileId({
            id: fileId,
            ts: Date.now(),
            folderId: parentId,
          });
          scheduleHighlightClear();
          return;
        }

        const newHistory = await rebuildHistory(parentId);
        if (!stillMounted()) return;

        setFolderHistory(newHistory);
        pendingEnsuredFileId.current = fileId;
        setCurrentFolderId(parentId);
        setCurrentFolderName(folderName);
        setHighlightedFileId({
          id: fileId,
          ts: Date.now(),
          folderId: parentId,
        });
        scheduleHighlightClear();
      } catch (err: unknown) {
        if (isCallerAborted(err)) return;
        void captureError({
          level: "error",
          source: "useLocateFile",
          message: `Locate file failed: ${classifyDriveError(err)}`,
        });
      } finally {
        locateInFlightRef.current = false;
        if (mounted) setIsLoadingTracks(false);
      }
    };

    const handleLocateListener = (ev: Event) => {
      void handleLocateFile(ev);
    };

    window.addEventListener(EVENT_LOCATE_FILE, handleLocateListener);
    return () => {
      mounted = false;
      abortController.abort();
      window.removeEventListener(EVENT_LOCATE_FILE, handleLocateListener);
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    };
  }, [
    accessToken,
    currentFolderId,
    setActiveTab,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setIsLoadingTracks,
    t,
  ]);

  return { highlightedFileId, pendingEnsuredFileId };
}
