import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { db } from "../../db/db";
import { getValidToken } from "../../utils/apiClient";
import { getFileParents, getFileName } from "../../utils/driveApi";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { listFolderChildren } from "../../utils/drivePagination";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { getCurrentUserEmail } from "../../utils/storageKeys";
import { pruneStaleRootRows } from "../../db/pruneRootRows";
import { isAbortError } from "../../hooks/player/utils";
import {
  FOLDER_MODULE,
  classifyFolderError,
  isAborted,
} from "./folderSelectionHelpers";
import type { FolderItem } from "./folderSelectionHelpers";

export function useFolderNavigation({
  token,
  initialFolderId,
  initialFolderName,
  initialFolderHistory,
  allowEscapeRoot,
  resolvedAppRoot,
}: {
  token: string;
  initialFolderId: string;
  initialFolderName?: string | undefined;
  initialFolderHistory: { id: string; name: string }[];
  allowEscapeRoot?: boolean | undefined;
  resolvedAppRoot: string | null;
}) {
  const { t } = useTranslation();

  const [currentFolderId, setCurrentFolderId] = useState(
    initialFolderId === ROOT_FOLDER_ID && resolvedAppRoot
      ? resolvedAppRoot
      : initialFolderId,
  );
  const [currentFolderName, setCurrentFolderName] = useState(
    initialFolderName || t("drive.my_drive"),
  );
  const [folderHistory, setFolderHistory] =
    useState<{ id: string; name: string }[]>(initialFolderHistory);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  // Loading starts TRUE so the first committed frame shows the skeleton —
  // starting false flashed the "no folders" empty state for one frame before
  // the effect set loading on (RC-B).
  const [isLoading, setIsLoading] = useState(true);
  const isLoadingRef = useRef(false);
  const foldersAbortRef = useRef<AbortController | null>(null);
  const parentWalkAbortRef = useRef<AbortController | null>(null);

  const cancelFolderFetch = useCallback(() => {
    foldersAbortRef.current?.abort();
    foldersAbortRef.current = null;
  }, []);

  const fetchFolders = async (folderId: string) => {
    cancelFolderFetch();
    const controller = new AbortController();
    foldersAbortRef.current = controller;

    isLoadingRef.current = true;
    setIsLoading(true);
    setFolders([]);
    try {
      // Per-user scoping (schema v10): only the signed-in account's folders.
      const ownerEmail = getCurrentUserEmail();
      const dbFolders = await db.files
        .where("[userEmail+parentId]")
        .equals([ownerEmail, folderId])
        .filter((f) => f.isFolder)
        .toArray();
      if (isAborted(controller)) return;
      // My Drive root is ALWAYS resolved from Drive: the cached root bucket
      // may be poisoned (rows historically persisted without a verified
      // parent), so it is never treated as authoritative. Non-root folders
      // keep the cache-first behavior unchanged.
      if (folderId !== ROOT_FOLDER_ID && dbFolders.length > 0) {
        setFolders(dbFolders.map((c) => ({ id: c.id, name: c.name })));
      } else {
        const freshToken = (await getValidToken()) || token;
        if (isAborted(controller)) return;
        const files = await listFolderChildren(
          freshToken,
          folderId,
          controller.signal,
        );
        if (isAborted(controller)) return;
        setFolders(files.map((f) => ({ id: f.id, name: f.name })));
        if (folderId === ROOT_FOLDER_ID && !isAborted(controller)) {
          // Fire-and-forget: the authoritative list is already displayed, and
          // a failed reconcile must never blank or block the picker.
          void pruneStaleRootRows(
            ownerEmail,
            new Set(files.map((file) => file.id)),
            { foldersOnly: true },
          );
        }
      }
    } catch (e) {
      if (isAbortError(e)) return;
      void captureError({
        level: "error",
        source: FOLDER_MODULE,
        message: `failed-to-fetch-folders: ${classifyFolderError(e)}`,
      });
      showErrorToast(t("folder_selection.folders_error"));
      setFolders([]);
    } finally {
      if (foldersAbortRef.current === controller) {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    // fetchFolders sets isLoading/folders synchronously — that is the
    // loading transition itself (skeleton state), not a cascading render:
    // the effect IS the fetch trigger. The alternative (delaying the
    // setState until after the first await) would flash the previous
    // folder's content, so this is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchFolders(currentFolderId);
    return () => {
      cancelFolderFetch();
    };
    // fetchFolders/cancelFolderFetch are local functions whose identity
    // changes every render; the effect only needs to refetch when the
    // folder or token changes, so they are intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, token]);

  useEffect(() => {
    // Unmount-only cleanup for the parent walk. Deliberately its OWN effect:
    // the fetch effect above re-runs on every folder change, and the walk
    // still awaits getFileName AFTER setCurrentFolderId — aborting from that
    // cleanup would drop the parent name the walk is about to commit.
    return () => {
      parentWalkAbortRef.current?.abort();
    };
  }, []);

  const handleOpenFolder = (folderId: string, folderName: string) => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    setIsLoading(true);
    setFolderHistory((prev) => [
      ...prev,
      { id: currentFolderId, name: currentFolderName },
    ]);
    setCurrentFolderId(folderId);
    setCurrentFolderName(folderName);
  };

  const popFolderHistory = (): boolean => {
    if (folderHistory.length === 0) return false;
    const newHistory = [...folderHistory];
    const prevFolder = newHistory.pop();
    const nextId = prevFolder?.id || resolvedAppRoot || ROOT_FOLDER_ID;
    if (nextId === currentFolderId) {
      // No-op pop that would not change the folder: aborting the in-flight
      // fetch here would strand the picker on the skeleton, because no
      // follow-up fetch is triggered to reset isLoading.
      return true;
    }
    cancelFolderFetch();
    // Same synchronous loading transition as handleOpenFolder (RC-B): the
    // first committed frame after the pop shows the skeleton instead of the
    // previous folder's cards.
    isLoadingRef.current = true;
    setIsLoading(true);
    setFolderHistory(newHistory);
    setCurrentFolderId(nextId);
    setCurrentFolderName(prevFolder?.name || t("drive.my_drive"));
    return true;
  };

  const navigateToParentFolder = async (): Promise<void> => {
    if (
      currentFolderId === ROOT_FOLDER_ID ||
      (!allowEscapeRoot &&
        resolvedAppRoot &&
        currentFolderId === resolvedAppRoot)
    )
      return;

    cancelFolderFetch();
    parentWalkAbortRef.current?.abort();
    const controller = new AbortController();
    parentWalkAbortRef.current = controller;

    isLoadingRef.current = true;
    setIsLoading(true);
    try {
      // Same fresh-token source as fetchFolders/searchSubfolders: the raw
      // prop token can be expired while getValidToken() refreshes (falling
      // back to the prop when no token is available).
      const freshToken = (await getValidToken()) || token;
      // The abort can land while this call was parked on the token refresh
      // (controller.signal does not stop an await) — bail out before hitting
      // Drive and before any state write, mirroring fetchFolders.
      if (isAborted(controller)) return;
      const parents = await getFileParents(
        freshToken,
        currentFolderId,
        controller.signal,
      );
      if (isAborted(controller)) return;
      if (parents === null) {
        // Drive request failed hard — fall back to root.
        setCurrentFolderId(ROOT_FOLDER_ID);
        setCurrentFolderName(t("drive.my_drive"));
      } else if (parents.length > 0) {
        const fetchedParentId = parents[0];
        if (fetchedParentId === undefined) {
          // Unreachable through parseParentsList today (it filters non-strings
          // out), but the early return must not strand isLoading=true with no
          // follow-up fetch: that froze the picker on its skeleton and blocked
          // handleOpenFolder for good.
          isLoadingRef.current = false;
          setIsLoading(false);
          return;
        }
        setCurrentFolderId(fetchedParentId);
        if (fetchedParentId === ROOT_FOLDER_ID) {
          setCurrentFolderName(t("drive.my_drive"));
        } else {
          try {
            const name = await getFileName(
              freshToken,
              fetchedParentId,
              controller.signal,
            );
            if (isAborted(controller)) return;
            if (name) setCurrentFolderName(name);
          } catch (e) {
            // Abort is a controlled teardown (superseded walk / unmount), not
            // a failure — never log or toast it.
            if (isAbortError(e)) return;
            void captureError({
              level: "warn",
              source: FOLDER_MODULE,
              message: `fetch-parent-name-failed: ${classifyFolderError(e)}`,
            });
          }
        }
      } else {
        setCurrentFolderId(ROOT_FOLDER_ID);
      }
    } catch (e) {
      if (isAbortError(e)) return;
      void captureError({
        level: "error",
        source: FOLDER_MODULE,
        message: `fetch-parent-failed: ${classifyFolderError(e)}`,
      });
      showErrorToast(t("folder_selection.back_error"));
      setCurrentFolderId(ROOT_FOLDER_ID);
      setCurrentFolderName(t("drive.my_drive"));
    }
  };

  const handleBack = async () => {
    if (popFolderHistory()) return;
    await navigateToParentFolder();
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      const crumbRootId = resolvedAppRoot || ROOT_FOLDER_ID;
      if (crumbRootId === currentFolderId) return;
      // Same synchronous loading transition as handleOpenFolder (RC-B).
      isLoadingRef.current = true;
      setIsLoading(true);
      setFolderHistory([]);
      setCurrentFolderId(crumbRootId);
      setCurrentFolderName(initialFolderName || t("drive.my_drive"));
      return;
    }
    const target = folderHistory[index];
    if (target === undefined) return;
    if (target.id === currentFolderId) return;
    // Same synchronous loading transition as handleOpenFolder (RC-B): the
    // first committed frame after the click shows the skeleton instead of
    // the current folder's cards.
    isLoadingRef.current = true;
    setIsLoading(true);
    setFolderHistory((prev) => prev.slice(0, index));
    setCurrentFolderId(target.id);
    setCurrentFolderName(target.name);
  };

  return {
    folders,
    isLoading,
    currentFolderId,
    currentFolderName,
    folderHistory,
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
  };
}
