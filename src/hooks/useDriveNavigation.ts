import { useCallback, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { recordFolderVisit } from "../utils/history";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB } from "../utils/driveConstants";
import { useDriveStore } from "../store/driveStore";
import { db } from "../db/db";
import { captureError } from "../utils/errorLog";
import {
  ROOT_FOLDER_KEY,
  getCurrentUserEmail,
  safeLocalStorageGet,
} from "../utils/storageKeys";
import type { BreadcrumbItem } from "../types";

const NAVIGATION_MODULE = "useDriveNavigation";
// Same ceiling as the locate-file history walk (useLocateFile.ts): a Drive
// ancestry deeper than this stops instead of looping forever.
const HISTORY_WALK_LIMIT = 20;

// Walks the REAL ancestry of a folder through the local Dexie mirror (the
// same source the search index is built from), returning the breadcrumb trail
// WITHOUT the folder itself — the useLocateFile rebuildHistory contract.
// Throws when any link is missing so the caller can fall back to the legacy
// append instead of rendering a half-true trail.
async function buildTrueHistory(
  targetFolderId: string,
): Promise<BreadcrumbItem[]> {
  const rootId =
    safeLocalStorageGet(
      ROOT_FOLDER_KEY,
      "locate-root-read",
      NAVIGATION_MODULE,
    ) || ROOT_FOLDER_ID;
  const newHistory: BreadcrumbItem[] = [];
  let current = targetFolderId;
  let remaining = HISTORY_WALK_LIMIT;
  while (current !== rootId && current !== ROOT_FOLDER_ID && remaining > 0) {
    remaining -= 1;
    const row = await db.files.get([getCurrentUserEmail(), current]);
    const realParentId = row?.parentId;
    if (!realParentId) {
      throw new Error(`history-walk-missing-parent (folderId=${current})`);
    }
    if (realParentId === rootId || realParentId === ROOT_FOLDER_ID) {
      newHistory.unshift({ id: realParentId, name: MY_DRIVE_TAB });
      break;
    }
    const parent = await db.files.get([getCurrentUserEmail(), realParentId]);
    if (!parent) {
      throw new Error(`history-walk-missing-folder (folderId=${realParentId})`);
    }
    newHistory.unshift({ id: parent.id, name: parent.name });
    current = realParentId;
  }
  return newHistory;
}

export const useDriveNavigation = () => {
  const navSeq = useRef(0);
  const {
    appRootFolder,
    folderHistory,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
  } = useDriveStore(
    useShallow((state) => ({
      appRootFolder: state.appRootFolder,
      folderHistory: state.folderHistory,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
    })),
  );

  // Global search spans the whole drive, so a clicked folder is often NOT a
  // child of the open folder (sibling/cross-branch jump). The optional
  // parentId (carried top-level on DriveItem by the search mapper) tells the
  // two cases apart: parent == current (or unknown) keeps the legacy blind
  // append for a true drill-down; any other known parent rebuilds the real
  // ancestry and REPLACES the trail instead of stacking a false child link.
  const handleOpenFolder = useCallback(
    (folderId: string, folderName: string, parentId?: string) => {
      // Fresh state via getState (not the closure): the cross-branch rebuild
      // awaits Dexie, and a second navigation may land while it is in flight.
      const { currentFolderId: openFromId, currentFolderName: openFromName } =
        useDriveStore.getState();
      if (folderId === openFromId) return;
      const seq = ++navSeq.current;
      if (parentId === undefined || parentId === openFromId) {
        setFolderHistory((prev) => [
          ...prev,
          { id: openFromId, name: openFromName },
        ]);
        setCurrentFolderId(folderId);
        setCurrentFolderName(folderName);
        void recordFolderVisit(folderId, folderName);
        return;
      }
      void (async () => {
        try {
          const trueHistory = await buildTrueHistory(folderId);
          if (seq !== navSeq.current) return;
          setFolderHistory(trueHistory);
          setCurrentFolderId(folderId);
          setCurrentFolderName(folderName);
          void recordFolderVisit(folderId, folderName);
        } catch (err: unknown) {
          if (seq !== navSeq.current) return;
          // Degraded but usable: the mirror lacks a link of the true path
          // (partial sync) — log with context and keep the legacy append.
          const reason =
            err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          void captureError({
            level: "warn",
            source: NAVIGATION_MODULE,
            message: `cross-branch-rebuild-failed (folderId=${folderId} parentId=${parentId}): ${reason}`,
          });
          setFolderHistory((prev) => [
            ...prev,
            { id: openFromId, name: openFromName },
          ]);
          setCurrentFolderId(folderId);
          setCurrentFolderName(folderName);
          void recordFolderVisit(folderId, folderName);
        }
      })();
    },
    [
      // currentFolderId/currentFolderName intentionally NOT deps: the guard
      // reads them fresh via getState (see above) so rapid successive opens
      // never decide on a stale folder.
      setFolderHistory,
      setCurrentFolderId,
      setCurrentFolderName,
    ],
  );

  const handleBack = useCallback(() => {
    if (folderHistory.length > 0) {
      ++navSeq.current;
      const newHistory = [...folderHistory];
      const previousFolder = newHistory.pop();
      setFolderHistory(newHistory);
      setCurrentFolderId(previousFolder?.id || appRootFolder || ROOT_FOLDER_ID);
      setCurrentFolderName(previousFolder?.name || MY_DRIVE_TAB);
    }
  }, [
    folderHistory,
    appRootFolder,
    setFolderHistory,
    setCurrentFolderId,
    setCurrentFolderName,
  ]);

  const handleBreadcrumbClick = useCallback(
    (id: string, name: string, index: number) => {
      ++navSeq.current;
      const newHistory = folderHistory.slice(0, index);
      setFolderHistory(newHistory);
      setCurrentFolderId(id);
      setCurrentFolderName(name);
    },
    [folderHistory, setFolderHistory, setCurrentFolderId, setCurrentFolderName],
  );

  return { handleOpenFolder, handleBack, handleBreadcrumbClick };
};
