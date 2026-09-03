import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { db } from "../../db/db";
import { matchesNormalized } from "../../search/searchEngine";
import { getValidToken } from "../../utils/apiClient";
import { FOLDER_MIME, getFileParents, getFileName } from "../../utils/driveApi";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { searchFolders, listFolderChildren } from "../../utils/drivePagination";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { isAbortError } from "../../hooks/player/utils";
import {
  FOLDER_MODULE,
  SEARCH_DEBOUNCE_MS,
  classifyFolderError,
  isAborted,
} from "./folderSelectionHelpers";
import type { FolderItem } from "./folderSelectionHelpers";

export function useFolderPicker({
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
  allowEscapeRoot?: boolean;
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
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [apiSearchResults, setApiSearchResults] = useState<FolderItem[]>([]);
  const [isSearchingApi, setIsSearchingApi] = useState(false);
  const isLoadingRef = useRef(false);
  const apiSearchAbortRef = useRef<AbortController | null>(null);
  const foldersAbortRef = useRef<AbortController | null>(null);

  const filteredFolders = useMemo(() => {
    if (!searchQuery.trim()) return folders;
    // matchesNormalized = same diacritics-insensitive, multi-token AND
    // semantics as global search (query "doi" finds folder "Đổi mới").
    return folders.filter((f) => matchesNormalized(f.name, searchQuery));
  }, [folders, searchQuery]);

  // B-K1: the deeper Drive search spans sublevels, so its hits can repeat a
  // direct child that already matched locally — rendering the same id in
  // both sections duplicated the card and tripped React's duplicate-key
  // warning (FolderGrid keys both sections by folder.id). The visible API
  // section drops every id the local listing already shows (plus the current
  // folder itself); deriving at render keeps the filter immune to stale
  // snapshots even when the folder list lands after the search resolved.
  const visibleApiResults = useMemo(() => {
    if (apiSearchResults.length === 0) return apiSearchResults;
    const localIds = new Set(folders.map((f) => f.id));
    return apiSearchResults.filter(
      (f) => f.id !== currentFolderId && !localIds.has(f.id),
    );
  }, [apiSearchResults, folders, currentFolderId]);

  // React "adjusting state during render" pattern: instead of resetting the
  // search in an effect (react-hooks/set-state-in-effect), reset it right
  // here when the active folder changes — state is adjusted synchronously
  // during render, before the browser paints the new folder.
  const [lastFetchedFolderId, setLastFetchedFolderId] =
    useState(currentFolderId);
  if (lastFetchedFolderId !== currentFolderId) {
    setLastFetchedFolderId(currentFolderId);
    setSearchQuery("");
    setApiSearchResults([]);
  }

  // API search results render whenever the query is non-empty (local and
  // deeper results coexist). When the query empties, stale results and the
  // in-flight flag must be cleared — done here during render, not inside the
  // debounce effect (the effect never sees an empty query).
  const apiSearchActive = Boolean(searchQuery.trim());
  const [lastApiSearchActive, setLastApiSearchActive] =
    useState(apiSearchActive);
  if (lastApiSearchActive !== apiSearchActive) {
    setLastApiSearchActive(apiSearchActive);
    if (!apiSearchActive) {
      setApiSearchResults([]);
      setIsSearchingApi(false);
    }
  }

  // Stale-guard: a query change must drop the previous query's API results
  // synchronously during render — otherwise the debounce window keeps
  // painting folders that matched the old query under the new one.
  const [lastSearchQuery, setLastSearchQuery] = useState(searchQuery);
  if (lastSearchQuery !== searchQuery) {
    setLastSearchQuery(searchQuery);
    setApiSearchResults([]);
  }

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
      const dbFolders = await db.files
        .where("parentId")
        .equals(folderId)
        .filter((f) => f.isFolder)
        .toArray();
      if (isAborted(controller)) return;
      if (dbFolders.length > 0) {
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

  const searchSubfolders = useCallback(
    async (query: string) => {
      apiSearchAbortRef.current?.abort();
      if (query.trim().length < 2) {
        setApiSearchResults([]);
        return;
      }
      const controller = new AbortController();
      apiSearchAbortRef.current = controller;
      setIsSearchingApi(true);
      try {
        const safeQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const q = `name contains '${safeQuery}' and mimeType='${FOLDER_MIME}' and trashed=false`;
        // Same fresh-token source as fetchFolders: the raw prop token can be
        // expired while getValidToken() refreshes (falling back to the prop
        // when no token is available). Rejection is caught below like any
        // other search failure.
        const freshToken = (await getValidToken()) || token;
        const files = await searchFolders(freshToken, q, controller.signal);
        // Overlap filtering lives in visibleApiResults (single source of
        // truth, recomputed against the current local listing at render).
        setApiSearchResults(files);
      } catch (e: unknown) {
        if (!isAbortError(e)) {
          setApiSearchResults([]);
          void captureError({
            level: "warn",
            source: FOLDER_MODULE,
            message: `api-search-failed: ${classifyFolderError(e)}`,
          });
          showErrorToast(t("folder_selection.search_error"));
        }
      } finally {
        setIsSearchingApi(false);
      }
    },
    // currentFolderId left the deps when overlap filtering moved to the
    // visibleApiResults derivation; a folder change resets the query during
    // render anyway, which re-runs the debounce effect below.
    [token, t],
  );

  useEffect(() => {
    // Deeper search fires for EVERY non-empty query regardless of local
    // matches — the old filteredFolders.length gate silently skipped the
    // Drive API search whenever a local folder matched, so folders outside
    // the current directory were unreachable ("can't search folder" bug).
    // Min-length 2 lives inside searchSubfolders; abort/unmount cleanup
    // below is unchanged.
    if (!searchQuery.trim()) return;
    const timer = setTimeout(() => {
      void searchSubfolders(searchQuery.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      apiSearchAbortRef.current?.abort();
    };
  }, [searchQuery, searchSubfolders]);

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
          setSearchQuery("");
        } else {
          searchInputRef.current?.focus();
        }
      }
      if (
        e.key === "Escape" &&
        document.activeElement === searchInputRef.current
      ) {
        searchInputRef.current?.blur();
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
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
    cancelFolderFetch();
    const newHistory = [...folderHistory];
    const prevFolder = newHistory.pop();
    setFolderHistory(newHistory);
    setCurrentFolderId(prevFolder?.id || resolvedAppRoot || ROOT_FOLDER_ID);
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
    isLoadingRef.current = true;
    setIsLoading(true);
    try {
      const parents = await getFileParents(token, currentFolderId);
      if (parents === null) {
        // Drive request failed hard — fall back to root.
        setCurrentFolderId(ROOT_FOLDER_ID);
        setCurrentFolderName(t("drive.my_drive"));
      } else if (parents.length > 0) {
        const fetchedParentId = parents[0];
        if (fetchedParentId === undefined) return;
        setCurrentFolderId(fetchedParentId);
        if (fetchedParentId === ROOT_FOLDER_ID) {
          setCurrentFolderName(t("drive.my_drive"));
        } else {
          try {
            const name = await getFileName(token, fetchedParentId);
            if (name) setCurrentFolderName(name);
          } catch (e) {
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
      setFolderHistory([]);
      setCurrentFolderId(resolvedAppRoot || ROOT_FOLDER_ID);
      setCurrentFolderName(initialFolderName || t("drive.my_drive"));
      return;
    }
    const target = folderHistory[index];
    if (target === undefined) return;
    setFolderHistory((prev) => prev.slice(0, index));
    setCurrentFolderId(target.id);
    setCurrentFolderName(target.name);
  };

  return {
    folders,
    isLoading,
    searchQuery,
    setSearchQuery,
    filteredFolders,
    apiSearchResults: visibleApiResults,
    isSearchingApi,
    currentFolderId,
    currentFolderName,
    folderHistory,
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
    searchInputRef,
  };
}
