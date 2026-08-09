import { useState, useEffect, useRef } from "react";
import {
  Trash2,
  X,
  RefreshCw,
  LoaderCircle,
  TriangleAlert,
  FileHeadphone,
  Folder,
  Check,
  SquareCheckBig,
  Ellipsis,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkeletonRowList } from "../components/Skeleton";
import {
  restoreFile,
  permanentlyDeleteFile,
  FOLDER_MIME,
} from "../../utils/driveApi";
import { getTrashedFiles } from "../../utils/drivePagination";
import { showErrorToast, showSuccessToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";

const TRASH_MODULE = "TrashScreen";

interface TrashScreenProps {
  token: string;
  onClose: () => void;
}

interface TrashedItem {
  id: string;
  name: string;
  mimeType: string;
}

export function TrashScreen({ token, onClose }: TrashScreenProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TrashedItem[]>([]);
  // Loading starts TRUE so the first committed frame shows the skeleton —
  // starting false flashed the "Trash is empty" state for one frame before
  // the effect set loading on (RC-B).
  const [isLoading, setIsLoading] = useState(true);
  const [isEmptying, setIsEmptying] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // Selection states
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkActioning, setIsBulkActioning] = useState(false);

  // More menu state
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        moreMenuRef.current &&
        !moreMenuRef.current.contains(e.target as Node)
      ) {
        setIsMoreMenuOpen(false);
      }
    };
    if (isMoreMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isMoreMenuOpen]);

  const fetchTrashed = async () => {
    try {
      // Fetch trashed audio files and folders that were deleted by DrPlay
      const q =
        "trashed=true and appProperties has { key='deletedByDrPlay' and value='true' }";
      const files = await getTrashedFiles(token, q);
      setItems(
        files.map((f: TrashedItem) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
        })),
      );
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `fetch-trashed-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("settings.trash_load_error"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // fetchTrashed only sets state after await, but the React Compiler
    // lint rule (set-state-in-effect) still traces the finally-setState
    // through the try/catch exception edges, so the disable stays.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTrashed();
    // fetchTrashed only closes over token (already in deps); its identity
    // changes every render but the effect must only run on token change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    try {
      await restoreFile(token, id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      window.dispatchEvent(new CustomEvent("refresh-drive"));
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `restore-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("settings.restore_error"));
    } finally {
      setRestoringId(null);
    }
  };

  const handleEmptyTrash = async () => {
    if (!window.confirm(t("settings.confirm_empty_trash"))) {
      return;
    }
    setIsEmptying(true);
    try {
      const deletePromises = items.map((item) =>
        permanentlyDeleteFile(token, item.id),
      );
      const results = await Promise.allSettled(deletePromises);
      const succeededIds = new Set<string>();
      let failedCount = 0;
      results.forEach((result, index) => {
        const item = items[index];
        if (item === undefined) return;
        if (result.status === "fulfilled") {
          succeededIds.add(item.id);
        } else {
          failedCount += 1;
          void captureError({
            level: "error",
            source: TRASH_MODULE,
            message: `empty-trash-item-failed: ${item.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          });
        }
      });
      if (failedCount > 0) {
        setItems((prev) => prev.filter((item) => !succeededIds.has(item.id)));
        showErrorToast(
          t("settings.empty_trash_error_count", { count: failedCount }),
        );
      } else {
        setItems([]);
        showSuccessToast(t("settings.empty_trash_success"));
        onClose();
      }
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `empty-trash-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("settings.empty_trash_error"));
    } finally {
      setIsEmptying(false);
    }
  };

  const handleBulkRestore = async () => {
    if (selectedIds.size === 0) return;
    setIsBulkActioning(true);
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(
        ids.map((id) => restoreFile(token, id)),
      );
      const succeededIds = new Set<string>();
      let failedCount = 0;
      results.forEach((result, index) => {
        const id = ids[index];
        if (id === undefined) return;
        if (result.status === "fulfilled") {
          succeededIds.add(id);
        } else {
          failedCount += 1;
          void captureError({
            level: "error",
            source: TRASH_MODULE,
            message: `bulk-restore-item-failed: ${id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          });
        }
      });
      setItems((prev) => prev.filter((item) => !succeededIds.has(item.id)));
      window.dispatchEvent(new CustomEvent("refresh-drive"));
      if (failedCount > 0) {
        showErrorToast(
          t("settings.bulk_restore_error_count", { count: failedCount }),
        );
        setSelectedIds((prev) => {
          const next = new Set(prev);
          succeededIds.forEach((id) => next.delete(id));
          return next;
        });
      } else {
        setSelectedIds(new Set());
        setIsSelectionMode(false);
      }
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `bulk-restore-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("settings.restore_error"));
    } finally {
      setIsBulkActioning(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsBulkActioning(true);
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(
        ids.map((id) => permanentlyDeleteFile(token, id)),
      );
      const succeededIds = new Set<string>();
      let failedCount = 0;
      results.forEach((result, index) => {
        const id = ids[index];
        if (id === undefined) return;
        if (result.status === "fulfilled") {
          succeededIds.add(id);
        } else {
          failedCount += 1;
          void captureError({
            level: "error",
            source: TRASH_MODULE,
            message: `bulk-delete-item-failed: ${id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          });
        }
      });
      setItems((prev) => prev.filter((item) => !succeededIds.has(item.id)));
      if (failedCount > 0) {
        showErrorToast(
          t("settings.bulk_delete_error_count", { count: failedCount }),
        );
        setSelectedIds((prev) => {
          const next = new Set(prev);
          succeededIds.forEach((id) => next.delete(id));
          return next;
        });
      } else {
        setSelectedIds(new Set());
        setIsSelectionMode(false);
      }
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `bulk-delete-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("settings.empty_trash_error"));
    } finally {
      setIsBulkActioning(false);
    }
  };

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-[#121212] w-full max-w-2xl h-[70vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-brand-primary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                ></path>
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 dark:text-white">
                {t("settings.trash")}
              </h1>
              <p className="text-xs text-gray-500 mt-0.5">
                {t("settings.trash_desc")}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 bg-white dark:bg-[#121212]">
          {isLoading ? (
            // The list area is a definite-height flex child (dialog h-[70vh]
            // flex-col), so h-full resolves and the stretch skeleton fills
            // the whole region instead of leaving a blank band (RC-C).
            <div role="status" aria-label={t("loading")} className="p-4 h-full">
              <SkeletonRowList
                rows={6}
                variant="trash"
                stretch
                containerClassName="flex flex-col gap-2 h-full"
              />
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-20 text-gray-500 flex flex-col items-center">
              <Trash2 className="w-16 h-16 mb-4 opacity-20" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-200">
                {t("settings.trash_empty")}
              </h3>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-1 py-3 mb-2">
                <div className="flex items-center gap-2 text-sm text-brand-primary font-medium">
                  <TriangleAlert className="w-5 h-5 shrink-0" />
                  <p>{t("settings.trash_warning")}</p>
                </div>
                <div className="relative" ref={moreMenuRef}>
                  {isSelectionMode ? (
                    <button
                      onClick={() => {
                        setIsSelectionMode(false);
                        setSelectedIds(new Set());
                      }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
                    >
                      {t("common.cancel")}
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setIsMoreMenuOpen(!isMoreMenuOpen);
                      }}
                      className="p-1.5 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Ellipsis className="w-5 h-5" />
                    </button>
                  )}

                  {isMoreMenuOpen && !isSelectionMode && (
                    <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-100 dark:border-white/5 p-1 z-50 animate-in fade-in zoom-in-95 duration-200">
                      <button
                        onClick={() => {
                          setIsSelectionMode(true);
                          setIsMoreMenuOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors group"
                      >
                        <SquareCheckBig className="w-4 h-4 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors" />
                        <span className="text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
                          {t("menu.select_multiple")}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {items.map((item) => {
                const isFolder = item.mimeType === FOLDER_MIME;
                const isSelected = selectedIds.has(item.id);
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    key={item.id}
                    className={`flex items-center justify-between p-3 rounded-xl transition-colors ${
                      isSelectionMode ? "cursor-pointer" : ""
                    } ${
                      isSelected
                        ? "bg-brand-primary/10 border border-brand-primary/30"
                        : "bg-gray-50 dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] border border-transparent"
                    }`}
                    onClick={() => {
                      if (isSelectionMode) toggleItem(item.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (isSelectionMode) toggleItem(item.id);
                      }
                    }}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      {isSelectionMode && (
                        <div
                          className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                            isSelected
                              ? "bg-brand-primary border-brand-primary"
                              : "border-gray-300 dark:border-gray-600 bg-white dark:bg-black/20"
                          }`}
                        >
                          {isSelected && (
                            <Check className="w-3.5 h-3.5 text-white" />
                          )}
                        </div>
                      )}
                      <div
                        className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isFolder ? "bg-amber-100 dark:bg-amber-900/30 text-amber-500" : "bg-brand-primary/10 text-brand-primary"}`}
                      >
                        {isFolder ? (
                          <Folder className="w-5 h-5" fill="currentColor" />
                        ) : (
                          <FileHeadphone className="w-5 h-5" />
                        )}
                      </div>
                      <div className="overflow-hidden">
                        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate max-w-[250px] sm:max-w-sm">
                          {item.name}
                        </h4>
                      </div>
                    </div>
                    {!isSelectionMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRestore(item.id);
                        }}
                        disabled={restoringId === item.id}
                        className="px-4 py-1.5 text-xs font-semibold text-green-600 bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 shrink-0"
                      >
                        {restoringId === item.id ? (
                          <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        <span className="hidden sm:inline">
                          {t("settings.restore")}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-between bg-gray-50/50 dark:bg-[#1a1b1e]/50 shrink-0">
          {isSelectionMode ? (
            <>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {selectedIds.size} {t("common.selected")}
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    void handleBulkRestore();
                  }}
                  disabled={selectedIds.size === 0 || isBulkActioning}
                  className="px-4 py-2.5 bg-brand-primary text-white rounded-xl text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {isBulkActioning ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  <span className="hidden sm:inline">
                    {t("settings.restore")}
                  </span>
                </button>
                <button
                  onClick={() => {
                    void handleBulkDelete();
                  }}
                  disabled={selectedIds.size === 0 || isBulkActioning}
                  className="px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {isBulkActioning ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  <span className="hidden sm:inline">{t("common.delete")}</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-gray-500 hidden sm:block">
                {items.length > 0
                  ? `${String(items.length)} ${t("settings.items_in_trash")}`
                  : ""}
              </p>
              <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
                <button
                  onClick={onClose}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                >
                  {t("folder_selection.cancel")}
                </button>
                <button
                  onClick={() => {
                    void handleEmptyTrash();
                  }}
                  disabled={items.length === 0 || isEmptying}
                  className="flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all transform active:scale-[0.98] shadow-sm disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
                >
                  {isEmptying ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  {t("settings.empty_trash")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
