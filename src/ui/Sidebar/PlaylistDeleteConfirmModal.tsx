import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Playlist } from "../../utils/playlists";

interface PlaylistDeleteConfirmModalProps {
  // Non-null = open. The playlist shown is the one the menu targeted.
  playlist: Playlist | null;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * In-app confirmation for deleting a playlist. `window.confirm` is not
 * reliable inside the Tauri WebView (script dialogs are host-controlled), so
 * the sidebar delete flow always confirms through this modal. Shell, button
 * styles and dialog conventions mirror MoreMenu/DeleteConfirmDialog: Escape /
 * backdrop cancel, initial focus on the least destructive control (Cancel),
 * focus returns to the invoker on close (a no-op when the ⋯ menu item that
 * opened it already unmounted, per APG).
 */
export function PlaylistDeleteConfirmModal({
  playlist,
  onClose,
  onConfirm,
}: PlaylistDeleteConfirmModalProps) {
  const { t } = useTranslation();
  const isOpen = playlist !== null;

  // Window CAPTURE so the press cannot reach the layers behind the modal
  // (list shortcuts, drawers) — a modal owns the key (APG dialog-modal).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen, onClose]);

  // Snapshot the invoker before focusing Cancel; restoring in the same effect
  // avoids observing the Cancel button as the invoker (DeleteConfirmDialog
  // convention).
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen]);

  if (playlist === null) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-delete-title"
        className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-sm shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200"
      >
        <div className="flex flex-col gap-2">
          <h3
            id="playlist-delete-title"
            className="text-lg font-bold text-gray-900 dark:text-white"
          >
            {t("confirm_delete_playlist")}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {playlist.name}
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 mt-2">
          <button
            ref={cancelRef}
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors"
          >
            {t("menu.cancel")}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-xl shadow-md transition-all flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            <span>{t("drive.delete")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
