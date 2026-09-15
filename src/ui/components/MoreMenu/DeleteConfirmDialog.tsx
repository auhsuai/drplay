import { useEffect, useRef } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import type { DriveItem } from "../../../types";

interface DeleteConfirmDialogProps {
  show: boolean;
  isDeleting: boolean;
  driveItem: DriveItem | null;
  onClose: () => void;
  onConfirm: () => void;
  t: import("i18next").TFunction;
}

export function DeleteConfirmDialog({
  show,
  isDeleting,
  driveItem,
  onClose,
  onConfirm,
  t,
}: DeleteConfirmDialogProps) {
  // Escape cancels the dialog (same guard as backdrop click/Cancel:
  // ignored while a delete is in flight). Window CAPTURE: the innermost
  // overlay swallows the press before the document (menu) and window (drawer)
  // listeners run — including while busy (APG dialog-modal); capture on
  // window still fires for window-dispatched events, so existing tests hold.
  useEffect(() => {
    if (!show) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!isDeleting) onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [show, onClose, isDeleting]);

  // APG dialog-modal: initial focus moves to the least destructive control
  // (Cancel, never Delete) and the invoker is remembered so focus returns on
  // close/unmount. Deliberately ONE effect: snapshotting the invoker in a
  // separate effect would observe the Cancel button as the invoker
  // (TrashScreen trap). The menu item that opens the dialog unmounts with the
  // menu, so its restore is a no-op there (per APG).
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!show) return;
    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelRef.current?.focus();
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
  }, [show]);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget && !isDeleting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-confirm-title"
        className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-sm shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200"
      >
        <div className="flex flex-col gap-2">
          <h3
            id="delete-confirm-title"
            className="text-lg font-bold text-gray-900 dark:text-white"
          >
            {t("drive.confirm_delete")}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {driveItem?.title}
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 mt-2">
          <button
            ref={cancelRef}
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
          >
            {t("menu.cancel")}
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-xl shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isDeleting ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            <span>{t("drive.delete")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
