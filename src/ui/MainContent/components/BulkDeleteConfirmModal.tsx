import { useEffect, useRef } from "react";
import { X, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

interface BulkDeleteConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isOperating: boolean;
  selectedCount: number;
}

export function BulkDeleteConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  isOperating,
  selectedCount,
}: BulkDeleteConfirmModalProps) {
  const { t } = useTranslation();

  // Escape closes the confirm (unless a bulk operation is in flight). Window
  // CAPTURE so the press cannot reach the layers behind the modal — the
  // drawer / selection shortcuts — and stopPropagation runs even while busy:
  // a modal owns the key, outer layers must stay inert (APG dialog-modal).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!isOperating) onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen, isOperating, onClose]);

  // APG dialog-modal focus return: remember the invoker (the toolbar Delete
  // button) while open, restore it on close/unmount. Cleanup covers both the
  // isOpen edge and a full unmount. Skip body/html (nothing useful to
  // restore) and detached nodes (invoker gone → leave focus alone, per APG).
  useEffect(() => {
    if (!isOpen) return;
    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
  }, [isOpen]);

  // APG dialog-modal: initial focus moves to the least destructive control
  // (Cancel, never Delete). Declared AFTER the invoker snapshot effect so the
  // snapshot still sees the real invoker instead of the Cancel button.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (isOpen) cancelRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget && !isOperating) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-delete-title"
        className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between">
          <h3
            id="bulk-delete-title"
            className="text-lg font-bold text-gray-900 dark:text-white"
          >
            {t("drive.bulk_delete_title")}
          </h3>
          <button
            onClick={onClose}
            disabled={isOperating}
            aria-label={t("common.close")}
            className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-1 rounded-full transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="text-gray-500 dark:text-gray-400 text-sm">
          {t("drive.bulk_delete_desc", { count: selectedCount })}
        </div>

        <div className="flex items-center justify-end gap-3 mt-2">
          <button
            ref={cancelRef}
            onClick={onClose}
            disabled={isOperating}
            className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
          >
            {t("menu.cancel")}
          </button>
          <button
            onClick={onConfirm}
            disabled={isOperating}
            className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm active:scale-95 disabled:opacity-50 flex items-center gap-2"
          >
            {isOperating && <LoaderCircle className="w-4 h-4 animate-spin" />}
            {t("drive.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
