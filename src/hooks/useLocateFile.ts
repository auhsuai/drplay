import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { db } from "../db/db";
import { fetchWithAuth } from "../utils/apiClient";
import { classifyDriveError } from "../utils/driveApi";
import {
  ROOT_FOLDER_ID,
  MY_DRIVE_TAB,
  type TabKey,
} from "../utils/driveConstants";
import { captureError } from "../utils/errorLog";
import { authHeaders, DRIVE_FILES_URL } from "../utils/driveFiles";

const HISTORY_LIMIT = 20;
const HIGHLIGHT_DURATION_MS = 5000;
const DRIVE_ID_PREFIX = "drive_";
const EVENT_LOCATE_FILE = "locate-file";
const STORAGE_KEY_ROOT = "drplay_root_folder";
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
  } | null>(null);
  const pendingEnsuredFileId = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const stillMounted = () => mounted;
    const handleLocateFile = async (ev: Event) => {
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
              const res = await fetchWithAuth(
                `${DRIVE_FILES_URL}/${current}?fields=parents`,
                {
                  headers: authHeaders(accessToken),
                },
              );
              if (res.ok) {
                const data = (await res.json()) as { parents?: string[] };
                if (data.parents && data.parents.length > 0) {
                  pId = data.parents[0];
                }
              }
            } catch (e: unknown) {
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
              const pRes = await fetchWithAuth(
                `${DRIVE_FILES_URL}/${pId}?fields=name`,
                {
                  headers: authHeaders(accessToken),
                },
              );
              if (pRes.ok) {
                const pData = (await pRes.json()) as { name?: unknown };
                newHistory.unshift({
                  id: pId,
                  name:
                    typeof pData.name === "string"
                      ? pData.name
                      : t("drive.unknown_folder", UNKNOWN_FOLDER),
                });
              } else {
                newHistory.unshift({
                  id: pId,
                  name: t("drive.unknown_folder", UNKNOWN_FOLDER),
                });
              }
            } catch (e: unknown) {
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

      setIsLoadingTracks(true);
      setActiveTab(MY_DRIVE_TAB);

      try {
        let parentId: string | null = null;
        let folderName = t("drive.unknown_folder", UNKNOWN_FOLDER);

        try {
          const response = await fetchWithAuth(
            `${DRIVE_FILES_URL}/${fileId}?fields=parents`,
            {
              headers: authHeaders(accessToken),
            },
          );
          if (response.ok) {
            const data = (await response.json()) as { parents?: string[] };
            if (!stillMounted()) return;
            if (data.parents && data.parents.length > 0) {
              const first = data.parents[0];
              if (first !== undefined) parentId = first;
            }
          }
        } catch (e: unknown) {
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
            const pRes = await fetchWithAuth(
              `${DRIVE_FILES_URL}/${parentId}?fields=name`,
              {
                headers: authHeaders(accessToken),
              },
            );
            if (pRes.ok) {
              const pData = (await pRes.json()) as { name?: unknown };
              if (!stillMounted()) return;
              folderName =
                typeof pData.name === "string"
                  ? pData.name
                  : t("drive.unknown_folder", UNKNOWN_FOLDER);
            }
          }
        }

        if (parentId === currentFolderId) {
          setHighlightedFileId({ id: fileId, ts: Date.now() });
          setTimeout(() => {
            setHighlightedFileId(null);
          }, HIGHLIGHT_DURATION_MS);
          return;
        }

        const newHistory = await rebuildHistory(parentId);
        if (!stillMounted()) return;

        setFolderHistory(newHistory);
        pendingEnsuredFileId.current = fileId;
        setCurrentFolderId(parentId);
        setCurrentFolderName(folderName);
        setHighlightedFileId({ id: fileId, ts: Date.now() });

        setTimeout(() => {
          setHighlightedFileId(null);
        }, HIGHLIGHT_DURATION_MS);
      } catch (err: unknown) {
        void captureError({
          level: "error",
          source: "useLocateFile",
          message: `Locate file failed: ${classifyDriveError(err)}`,
        });
      } finally {
        if (mounted) setIsLoadingTracks(false);
      }
    };

    const handleLocateListener = (ev: Event) => {
      void handleLocateFile(ev);
    };

    window.addEventListener(EVENT_LOCATE_FILE, handleLocateListener);
    return () => {
      mounted = false;
      window.removeEventListener(EVENT_LOCATE_FILE, handleLocateListener);
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
