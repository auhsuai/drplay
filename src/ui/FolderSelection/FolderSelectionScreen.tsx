import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  Folder,
  ArrowLeft,
  HardDrive,
  Check,
  Search,
  LoaderCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkeletonRowList } from "../components/Skeleton";
import { db } from "../../db/db";
import { matchesNormalized } from "../../search/searchEngine";
import { getValidToken } from "../../utils/apiClient";
import { getFileParents, getFileName } from "../../utils/driveApi";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { searchFolders, listFolderChildren } from "../../utils/drivePagination";
import { showErrorToast } from "../../utils/simpleToast";
import { ROOT_FOLDER_KEY } from "../../utils/storageKeys";
import { captureError } from "../../utils/errorLog";

const FOLDER_MODULE = "FolderSelection";
const SEARCH_DEBOUNCE_MS = 300;
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

// Classify a Drive fetch error for observability. Returns name + message only.
function classifyFolderError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

// fetch aborts (AbortController/AbortSignal) reject with a DOMException named
// 'AbortError' — the caller requested the cancellation, so it must not be
// surfaced as a user-facing error. Check both shapes: browsers' DOMException
// extends Error, but jsdom's implementation does not.
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  return (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "AbortError"
  );
}

// Race guard: cancelFolderFetch() aborts the controller from OUTSIDE this
// function while an await is in flight, so signal.aborted is genuinely
// reachable here even though typescript-eslint's flow analysis narrows a
// freshly-created controller's signal to "never aborted". The indirection
// keeps the check opaque to that narrowing.
function isAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

interface FolderItem {
  id: string;
  name: string;
}

function FolderCard({
  folder,
  onClick,
}: {
  folder: FolderItem;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="p-4 rounded-xl bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md hover:-translate-y-1 transition-all duration-300 cursor-pointer group flex items-center gap-4"
    >
      <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-amber-100 dark:bg-amber-900/30 text-amber-500">
        <Folder className="w-6 h-6" fill="currentColor" />
      </div>
      <div className="overflow-hidden flex-1">
        <h3 className="font-semibold text-gray-800 dark:text-gray-200 group-hover:text-[#4285F4] transition-colors truncate">
          {folder.name}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {t("drive.folders")}
        </p>
      </div>
    </div>
  );
}

interface FolderSelectionScreenProps {
  token: string;
  onSelectFolder: (folderId: string) => void;
  onCancel?: (() => void) | undefined; // Optional cancel for when called from Settings
  initialFolderId?: string;
  initialFolderName?: string | undefined;
  initialFolderHistory?: { id: string; name: string }[] | undefined;
  title?: string;
  subtitle?: string;
  appRootFolder?: string | null;
  allowEscapeRoot?: boolean;
}

export function FolderSelectionScreen({
  token,
  onSelectFolder,
  onCancel,
  initialFolderId = ROOT_FOLDER_ID,
  initialFolderName,
  initialFolderHistory = [],
  title,
  subtitle,
  appRootFolder,
  allowEscapeRoot = false,
}: FolderSelectionScreenProps) {
  const { t } = useTranslation();

  // Resolve appRootFolder from props or localStorage.
  // localStorage access can throw SecurityError (storage blocked by policy —
  // see MDN Window.localStorage), so the read is guarded and falls back to
  // null (same as a missing key).
  let storedAppRoot: string | null = null;
  try {
    storedAppRoot = localStorage.getItem(ROOT_FOLDER_KEY);
  } catch (err) {
    void captureError({
      level: "warn",
      source: "FolderSelectionScreen",
      message: `root-folder-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
  }
  const resolvedAppRoot = appRootFolder || storedAppRoot;

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
        const q = `name contains '${safeQuery}' and mimeType='${DRIVE_FOLDER_MIME_TYPE}' and trashed=false`;
        const files = await searchFolders(token, q, controller.signal);
        setApiSearchResults(
          files.filter((f: FolderItem) => f.id !== currentFolderId),
        );
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
    [token, currentFolderId, t],
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

  const handleBack = async () => {
    if (folderHistory.length > 0) {
      cancelFolderFetch();
      const newHistory = [...folderHistory];
      const prevFolder = newHistory.pop();
      setFolderHistory(newHistory);
      setCurrentFolderId(prevFolder?.id || resolvedAppRoot || ROOT_FOLDER_ID);
      setCurrentFolderName(prevFolder?.name || t("drive.my_drive"));
      return;
    }

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

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget && onCancel) onCancel();
      }}
    >
      <div className="bg-white dark:bg-[#121212] w-full max-w-3xl h-[75vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
              <HardDrive className="text-[#4285F4] w-6 h-6" />
              {title || t("folder_selection.select_root")}
            </h1>
            <p className="text-xs text-gray-500 mt-1">
              {subtitle || t("folder_selection.select_music_folder")}
            </p>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                ></path>
              </svg>
            </button>
          )}
        </div>

        {/* Toolbar / Breadcrumb / Search */}
        <div className="px-6 py-3 flex items-center gap-2 shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50">
          <button
            onClick={() => {
              void handleBack();
            }}
            disabled={
              folderHistory.length === 0 &&
              (currentFolderId === ROOT_FOLDER_ID ||
                (!allowEscapeRoot && currentFolderId === resolvedAppRoot))
            }
            className="p-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4 text-gray-700 dark:text-gray-300" />
          </button>

          <div className="flex items-center text-sm font-medium overflow-x-auto whitespace-nowrap hide-scrollbar flex-1 min-w-0 mr-2">
            {folderHistory.map((item, index) => (
              <React.Fragment key={index}>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    handleBreadcrumbClick(index);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleBreadcrumbClick(index);
                    }
                  }}
                  className="cursor-pointer text-gray-500 dark:text-gray-400 hover:text-[#4285F4] transition-colors"
                >
                  {item.name}
                </span>
                <span className="mx-2 text-gray-400 dark:text-gray-600">/</span>
              </React.Fragment>
            ))}
            <span className="text-gray-900 dark:text-white truncate">
              {currentFolderName}
            </span>
          </div>

          <div className="relative shrink-0 w-56">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t("search_placeholder")}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
              }}
              className="w-full pl-9 pr-3 py-2 text-sm bg-gray-100 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-white dark:focus:bg-[#1c1d21] text-gray-900 dark:text-gray-100 rounded-xl border border-transparent focus:border-[#4285F4]/50 outline-none transition-all placeholder:text-gray-500"
            />
          </div>
        </div>

        {/* Folder List */}
        <div className="flex-1 overflow-y-auto p-6 bg-white dark:bg-[#121212]">
          {isLoading && !isSearchingApi ? (
            // The folder list is a definite-height flex child (dialog
            // h-[75vh] flex-col), so h-full resolves and the stretch
            // skeleton fills the whole region instead of leaving a blank
            // band (RC-C).
            <div role="status" aria-label={t("loading")} className="p-6 h-full">
              <SkeletonRowList
                rows={6}
                variant="folder"
                containerClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 h-full auto-rows-fr"
              />
            </div>
          ) : searchQuery.trim() &&
            filteredFolders.length === 0 &&
            apiSearchResults.length === 0 &&
            !isSearchingApi ? (
            <div className="text-center py-20 text-gray-500">
              <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <h3 className="text-lg font-medium mb-1 text-gray-900 dark:text-gray-200">
                {t("drive.no_folders")}
              </h3>
            </div>
          ) : searchQuery.trim() &&
            (apiSearchResults.length > 0 || isSearchingApi) ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredFolders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onClick={() => {
                    handleOpenFolder(folder.id, folder.name);
                  }}
                />
              ))}
              {filteredFolders.length > 0 && (
                <div className="col-span-full text-[11px] font-bold text-gray-400 uppercase tracking-wider pt-2 pb-1">
                  {t("folder_selection.from_subfolders")}
                </div>
              )}
              {apiSearchResults.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onClick={() => {
                    handleOpenFolder(folder.id, folder.name);
                  }}
                />
              ))}
              {isSearchingApi && (
                <div className="col-span-full flex items-center justify-center gap-2 py-4 text-sm text-gray-400">
                  <LoaderCircle className="w-4 h-4 animate-spin" />
                  {t("folder_selection.searching_deeper")}
                </div>
              )}
            </div>
          ) : !searchQuery.trim() &&
            filteredFolders.length === 0 &&
            !isLoading ? (
            <div className="text-center py-20 text-gray-500">
              <Folder className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <h3 className="text-lg font-medium mb-1 text-gray-900 dark:text-gray-200">
                {t("drive.no_folders")}
              </h3>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredFolders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onClick={() => {
                    handleOpenFolder(folder.id, folder.name);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 flex items-center justify-end gap-3 shrink-0">
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              {t("folder_selection.cancel")}
            </button>
          )}
          <button
            onClick={() => {
              onSelectFolder(currentFolderId);
            }}
            className="flex items-center gap-2 bg-[#4285F4] hover:bg-[#3367d6] text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all transform active:scale-[0.98] shadow-sm"
          >
            <Check className="w-4 h-4" />
            {t("folder_selection.choose_folder")}
          </button>
        </div>
      </div>
    </div>
  );
}
