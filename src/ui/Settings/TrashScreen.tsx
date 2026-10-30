import { useState, useEffect, useRef, useCallback } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { restoreFile, permanentlyDeleteFile } from "../../utils/driveApi";
import { showErrorToast, showSuccessToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TrashItemsContent } from "./Trash/TrashItemsContent";
import { TrashActionBar } from "./Trash/TrashActionBar";
import {
  removeIdsFromSelection,
  runBulkOperation,
  describeError,
  TRASH_MODULE,
} from "./trashBulkOps";
import { useTrashedFiles } from "./useTrashedFiles";
import {
  sortTrashedItems,
  DEFAULT_TRASH_SORT_DIRECTION,
} from "./sortTrashedItems";
import type { TrashSortKey, TrashSortDirection } from "./sortTrashedItems";

interface TrashScreenProps {
  token: string;
  onClose: () => void;
}

// There is no native confirm() available: tauri-plugin-dialog 2.x overwrites
// window.confirm with an ASYNC shim that invokes "plugin:dialog|confirm", a
// command the Rust plugin no longer registers (confirm/ask are deprecated
// aliases of "message"), so every window.confirm() rejected unhandled and the
// action never ran. All destructive confirmations therefore go through the
// in-app ConfirmDialog, tracked here as one shared pending action.
type PendingConfirm =
  | { kind: "delete-item"; id: string }
  | { kind: "empty-trash" }
  | { kind: "bulk-delete" };

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
  // Sort state lives here (the screen owns all list behavior); the header and
  // rows are presentational. Restores/deletes prune ids and never touch these
  // values, so a bulk operation cannot reset the user's chosen sorting.
  // Default: Date added to Trash, newest first (task spec §3.1).
  const [sortKey, setSortKey] = useState<TrashSortKey>("deletedAt");
  const [sortDirection, setSortDirection] = useState<TrashSortDirection>(
    DEFAULT_TRASH_SORT_DIRECTION.deletedAt,
  );
  // One shared in-app confirmation for every destructive action (row delete,
  // empty trash, bulk delete). Row and bulk flows therefore can never stack
  // two dialogs on top of each other.
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );
  // Synchronous re-entry latch: a rapid double click on the dialog's confirm
  // button must still run the action exactly once (state updates alone are
  // not visible to a second click in the same tick).
  const confirmInFlightRef = useRef(false);
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
  // backdrop) and while the confirmation dialog is open: that dialog listens on
  // the same window capture target and owns the key itself, otherwise Escape
  // would close the whole trash view underneath it. Cleanup on unmount.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingConfirm !== null) return;
      e.stopPropagation();
      if (!isBulkActioning && !isEmptying) onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isBulkActioning, isEmptying, pendingConfirm, onClose]);

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
  const performDelete = async (id: string) => {
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

  const handleDelete = (id: string) => {
    setPendingConfirm({ kind: "delete-item", id });
  };

  const performEmptyTrash = async () => {
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

  const handleEmptyTrash = () => {
    setPendingConfirm({ kind: "empty-trash" });
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

  const performBulkDelete = async () => {
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

  const handleBulkDelete = () => {
    if (selectedIds.size === 0 || isBulkActioning) return;
    setPendingConfirm({ kind: "bulk-delete" });
  };

  // The single confirm entry point for the shared dialog: runs the pending
  // action exactly once (a synchronous latch invalidates the click before any
  // state update lands, so a double click cannot re-fire), then closes the
  // dialog once the operation settles.
  const handleConfirmAction = () => {
    if (pendingConfirm === null || confirmInFlightRef.current) return;
    confirmInFlightRef.current = true;
    const action = pendingConfirm;
    void (async () => {
      try {
        if (action.kind === "delete-item") {
          await performDelete(action.id);
        } else if (action.kind === "empty-trash") {
          await performEmptyTrash();
        } else {
          await performBulkDelete();
        }
      } finally {
        confirmInFlightRef.current = false;
        setPendingConfirm(null);
      }
    })();
  };

  const handleCancelConfirm = useCallback(() => {
    if (confirmInFlightRef.current) return;
    setPendingConfirm(null);
  }, []);

  // Busy state for the confirmation dialog: mirrors the guard the action
  // itself uses, so the confirm button shows a spinner and neither it nor
  // Cancel/Escape/X can fire while the request is in flight.
  const isConfirmOperating =
    pendingConfirm !== null &&
    (pendingConfirm.kind === "delete-item"
      ? deletingIds.has(pendingConfirm.id)
      : pendingConfirm.kind === "empty-trash"
        ? isEmptying
        : isBulkActioning);

  // Copy for the shared confirmation dialog: the body stays the exact key the
  // old window.confirm call received; the title names the action being taken.
  const confirmBodyKey =
    pendingConfirm === null
      ? "settings.trash_delete_confirm"
      : pendingConfirm.kind === "delete-item"
        ? "settings.trash_delete_confirm"
        : pendingConfirm.kind === "empty-trash"
          ? "settings.confirm_empty_trash"
          : "settings.confirm_bulk_delete";
  const confirmDialogTitle =
    pendingConfirm === null
      ? ""
      : pendingConfirm.kind === "delete-item"
        ? t("settings.trash_delete_item")
        : pendingConfirm.kind === "empty-trash"
          ? t("settings.empty_trash")
          : t("settings.trash_delete_selected");
  const confirmLabel = t("common.delete");

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

  // Selecting a new column applies its default direction; clicking the active
  // column toggles direction (Google Drive header behavior).
  const handleSortChange = (key: TrashSortKey) => {
    if (key === sortKey) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection(DEFAULT_TRASH_SORT_DIRECTION[key]);
    }
  };

  // Copy-on-sort (sortTrashedItems never mutates the hook's state array).
  // Folders stay grouped first inside the comparator.
  const sortedItems = sortTrashedItems(items, sortKey, sortDirection);

  return (
    <>
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
          <TrashItemsContent
            items={sortedItems}
            isLoading={isLoading}
            selectedIds={selectedIds}
            restoringIds={restoringIds}
            deletingIds={deletingIds}
            allSelected={allSelected}
            someSelected={someSelected}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSortChange={handleSortChange}
            onToggleItem={toggleItem}
            onToggleAll={toggleAll}
            onRestore={handleRestore}
            onDelete={handleDelete}
          />

          {/* Footer */}
          <TrashActionBar
            selectedCount={selectedIds.size}
            itemCount={items.length}
            isBulkActioning={isBulkActioning}
            isEmptying={isEmptying}
            onBulkRestore={handleBulkRestore}
            onBulkDelete={handleBulkDelete}
            onEmptyTrash={handleEmptyTrash}
            onClose={onClose}
          />
        </div>
      </div>

      {/* In-app confirmation for every destructive action: window.confirm is
          dead in the packaged app (see PendingConfirm). The message text is the
          same t() key that window.confirm used to receive. */}
      <ConfirmDialog
        isOpen={pendingConfirm !== null}
        title={confirmDialogTitle}
        body={pendingConfirm === null ? "" : t(confirmBodyKey)}
        confirmLabel={confirmLabel}
        cancelLabel={t("common.cancel")}
        onClose={handleCancelConfirm}
        onConfirm={handleConfirmAction}
        isOperating={isConfirmOperating}
      />
    </>
  );
}
