import { useState, useEffect, useRef } from "react";
import { Trash2, X, RefreshCw, LoaderCircle, Check, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkeletonRowList } from "../components/Skeleton";
import { restoreFile, permanentlyDeleteFile } from "../../utils/driveApi";
import { showErrorToast, showSuccessToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";
import { TrashItemRow } from "./TrashItemRow";
import {
  removeIdsFromSelection,
  runBulkOperation,
  describeError,
  TRASH_MODULE,
} from "./trashBulkOps";
import { useTrashedFiles } from "./useTrashedFiles";

interface TrashScreenProps {
  token: string;
  onClose: () => void;
}

// Set membership toggle shared by the per-row busy indicators and the
// selection set (add/remove one id without duplicating the Set dance).
const withMembership = (
  prev: Set<string>,
  id: string,
  on: boolean,
): Set<string> => {
  const next = new Set(prev);
  if (on) next.add(id);
  else next.delete(id);
  return next;
};

export function TrashScreen({ token, onClose }: TrashScreenProps) {
  const { t } = useTranslation();
  const { items, setItems, isLoading, setIsLoading } = useTrashedFiles(token);
  const [isEmptying, setIsEmptying] = useState(false);
  // A Set, not a single slot: two restores/deletes can be in flight at once,
  // and one completing must not clear the other's spinner/disabled state.
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const markRestoring = (id: string, on: boolean) => {
    setRestoringIds((prev) => withMembership(prev, id, on));
  };
  const markDeleting = (id: string, on: boolean) => {
    setDeletingIds((prev) => withMembership(prev, id, on));
  };

  // Selection states — the row checkboxes are always visible, so there is no
  // separate "selection mode" to enter/leave.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkActioning, setIsBulkActioning] = useState(false);
  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // APG dialog-modal (P2-05-6): initial focus moves into the dialog (the Close
  // button is the first control) and the invoker is remembered so focus returns
  // on close/unmount. Combined in one effect on purpose: the invoker snapshot
  // must be taken BEFORE focus moves into the dialog (the two-effect mirror of
  // BulkDeleteConfirmModal would snapshot the Close button instead).
  useEffect(() => {
    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButtonRef.current?.focus();
    return () => {
      if (
        invoker &&
        invoker !== document.body &&
        invoker !== document.documentElement &&
        invoker.isConnected
      ) {
        invoker.focus();
      }
    };
  }, []);

  // Escape closes the dialog. Window CAPTURE + stopPropagation mirror
  // BulkDeleteConfirmModal: a modal owns the key, layers behind stay inert.
  // Ignored while a destructive action is in flight (same guard as the X and
  // backdrop); cleanup on unmount.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!isBulkActioning && !isEmptying) onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isBulkActioning, isEmptying, onClose]);

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Empty states"): forces the
  // trash empty state by clearing items and dropping the loading flag so the
  // skeleton leaves immediately. onDebugEvent no-ops in production builds;
  // the listener never runs there.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.TRASH_EMPTY, () => {
      setItems([]);
      setIsLoading(false);
    });
    // setState functions are useState setters (stable identities), so this
    // still subscribes exactly once.
  }, [setItems, setIsLoading]);

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Loading / MainContent"):
  // forces the trash skeleton. isLoading is checked BEFORE items in the
  // render branch, so the loaded list is simply hidden again; the next fetch
  // (token change / reopen) leaves the skeleton as usual. onDebugEvent no-ops
  // in production builds; the listener never runs there.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.SKELETON, (detail) => {
      if (detail.target === "trash") {
        setIsLoading(true);
      }
    });
    // setIsLoading is a useState setter (stable identity), so this still
    // subscribes exactly once.
  }, [setIsLoading]);

  const handleRestore = async (id: string) => {
    markRestoring(id, true);
    try {
      await restoreFile(token, id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      window.dispatchEvent(new CustomEvent("refresh-drive"));
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `restore-failed: ${describeError(e)}`,
      });
      showErrorToast(t("settings.restore_error"));
    } finally {
      markRestoring(id, false);
    }
  };

  // Per-row permanent delete (new): confirm first, log + toast on failure,
  // prune the id from the selection so the bulk toolbar count stays accurate.
  const handleDelete = async (id: string) => {
    if (!window.confirm(t("settings.trash_delete_confirm"))) return;
    markDeleting(id, true);
    try {
      await permanentlyDeleteFile(token, id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      setSelectedIds((prev) => withMembership(prev, id, false));
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `delete-item-failed: ${describeError(e)}`,
      });
      showErrorToast(t("settings.trash_delete_error"));
    } finally {
      markDeleting(id, false);
    }
  };

  const handleEmptyTrash = async () => {
    if (!window.confirm(t("settings.confirm_empty_trash"))) {
      return;
    }
    setIsEmptying(true);
    try {
      const ids = items.map((item) => item.id);
      const { succeededIds, failedCount } = await runBulkOperation(
        items.map((item) => () => permanentlyDeleteFile(token, item.id)),
        ids,
        "empty-trash-item-failed",
      );
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
        message: `empty-trash-failed: ${describeError(e)}`,
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
      const { succeededIds, failedCount } = await runBulkOperation(
        ids.map((id) => () => restoreFile(token, id)),
        ids,
        "bulk-restore-item-failed",
      );
      setItems((prev) => prev.filter((item) => !succeededIds.has(item.id)));
      window.dispatchEvent(new CustomEvent("refresh-drive"));
      if (failedCount > 0) {
        showErrorToast(
          t("settings.bulk_restore_error_count", { count: failedCount }),
        );
        setSelectedIds((prev) => removeIdsFromSelection(prev, succeededIds));
      } else {
        setSelectedIds(new Set());
      }
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `bulk-restore-failed: ${describeError(e)}`,
      });
      showErrorToast(t("settings.restore_error"));
    } finally {
      setIsBulkActioning(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0 || isBulkActioning) return;
    if (!window.confirm(t("settings.confirm_bulk_delete"))) return;
    setIsBulkActioning(true);
    try {
      const ids = Array.from(selectedIds);
      const { succeededIds, failedCount } = await runBulkOperation(
        ids.map((id) => () => permanentlyDeleteFile(token, id)),
        ids,
        "bulk-delete-item-failed",
      );
      setItems((prev) => prev.filter((item) => !succeededIds.has(item.id)));
      if (failedCount > 0) {
        showErrorToast(
          t("settings.bulk_delete_error_count", { count: failedCount }),
        );
        setSelectedIds((prev) => removeIdsFromSelection(prev, succeededIds));
      } else {
        setSelectedIds(new Set());
      }
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `bulk-delete-failed: ${describeError(e)}`,
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

  const toggleAll = () => {
    setSelectedIds(
      allSelected ? new Set() : new Set(items.map((item) => item.id)),
    );
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
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-title"
        className="bg-white dark:bg-[#121212] w-full max-w-2xl h-[70vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header — title + the 30-day note, Close on the right */}
        <div className="px-6 py-4 flex items-start justify-between shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50">
          <div className="min-w-0">
            <h1
              id="trash-title"
              className="text-lg font-bold text-gray-900 dark:text-white"
            >
              {t("settings.trash")}
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {t("settings.trash_warning")}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label={t("common.close")}
            className="p-2 text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto bg-white dark:bg-[#121212]">
          {isLoading ? (
            // Skeleton rows mirror the flat TrashItemRow (h-12 rows with a
            // hairline divider): no stretch and no h-full on the container,
            // which divided the list height across rows and made them up to
            // ~2x taller on tall screens.
            <div role="status" aria-label={t("loading")} className="h-full">
              <SkeletonRowList
                rows={6}
                variant="trash"
                containerClassName="flex flex-col"
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
            <>
              <div className="sticky top-0 z-10 flex h-9 items-center border-b border-gray-200 bg-white px-3 dark:border-[#2A2A2A] dark:bg-[#121212]">
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="relative inline-flex shrink-0">
                    <input
                      ref={(el) => {
                        // Native partial state: checked stays false while only
                        // some rows are selected.
                        if (el) el.indeterminate = someSelected;
                      }}
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="peer appearance-none w-4 h-4 rounded border-2 border-gray-400 dark:border-gray-500 bg-white dark:bg-[#2a2b2f] checked:bg-brand-primary checked:border-brand-primary indeterminate:bg-brand-primary indeterminate:border-brand-primary cursor-pointer transition-colors"
                    />
                    <Check
                      className="absolute inset-0 m-auto w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none"
                      strokeWidth={3}
                    />
                    {someSelected && (
                      <Minus
                        className="absolute inset-0 m-auto w-3 h-3 text-white pointer-events-none"
                        strokeWidth={3}
                      />
                    )}
                  </span>
                  <span className="text-xs font-medium text-gray-500">
                    {allSelected
                      ? t("settings.trash_unselect_all")
                      : t("settings.trash_select_all")}
                  </span>
                </label>
              </div>
              {items.map((item) => (
                <TrashItemRow
                  key={item.id}
                  item={item}
                  isSelected={selectedIds.has(item.id)}
                  isRestoring={restoringIds.has(item.id)}
                  isDeleting={deletingIds.has(item.id)}
                  onToggle={toggleItem}
                  onRestore={handleRestore}
                  onDelete={handleDelete}
                />
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-between bg-gray-50/50 dark:bg-[#1a1b1e]/50 shrink-0">
          {selectedIds.size > 0 ? (
            <>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {selectedIds.size} {t("common.selected")}
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    void handleBulkRestore();
                  }}
                  disabled={isBulkActioning}
                  className="px-4 py-2.5 bg-brand-primary text-white rounded-xl text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {isBulkActioning ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  <span className="hidden sm:inline">
                    {t("settings.trash_restore_selected")}
                  </span>
                </button>
                <button
                  onClick={() => {
                    void handleBulkDelete();
                  }}
                  disabled={isBulkActioning}
                  className="px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {isBulkActioning ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  <span className="hidden sm:inline">
                    {t("settings.trash_delete_selected")}
                  </span>
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
