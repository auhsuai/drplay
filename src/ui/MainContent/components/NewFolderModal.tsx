import { useState, useRef, useEffect } from "react";
import { X, LoaderCircle, FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { showErrorToast } from "../../../utils/simpleToast";

interface NewFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void> | void;
  isCreating: boolean;
}

export function NewFolderModal({
  isOpen,
  onClose,
  onCreate,
  isCreating,
}: NewFolderModalProps) {
  const { t } = useTranslation();
  const [newFolderName, setNewFolderName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  // APG dialog-modal: snapshot the invoker and move focus into the dialog
  // (the name field) in ONE effect — a separate snapshot effect would observe
  // the name field as the invoker (TrashScreen trap). Cleanup restores the
  // invoker on close/unmount; skip body/html and detached nodes.
  useEffect(() => {
    if (!isOpen) return;
    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    nameInputRef.current?.focus();
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

  // Fresh name on every open: a failed create keeps the modal open and the
  // typed name must survive for a retry (useDriveBulkOps contract), so the
  // field can only be cleared here. Adjusting state during render is the
  // sanctioned alternative to a reset effect (react.dev — "Adjusting some
  // state when a prop changes").
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) setNewFolderName("");
  }

  // Escape cancels the modal (same guard as backdrop click/X/Cancel:
  // ignored while a create is in flight). Window CAPTURE + stopPropagation
  // mirror BulkDeleteConfirmModal: a modal owns the key, layers behind it
  // (e.g. the QueuePanel drawer) stay inert (APG dialog-modal).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!isCreating) onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen, onClose, isCreating]);

  if (!isOpen) return null;

  const handleCreate = () => {
    const name = newFolderName.trim();
    if (!name) return;
    // Reject characters that are invalid in Drive/folder names before calling the API.
    if (/[\\/:*?"<>|]/.test(name)) {
      showErrorToast(
        t("drive.folder_name_invalid") ||
          "Folder name contains invalid characters",
      );
      return;
    }
    // Fire-and-forget: the parent owns the outcome (closes the modal on
    // success, keeps it open with the name intact on failure). The field only
    // resets when the modal is reopened (effect above).
    void onCreate(name);
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget && !isCreating) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-folder-title"
        className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between">
          <h3
            id="new-folder-title"
            className="text-lg font-bold text-gray-900 dark:text-white"
          >
            {t("drive.new_folder_title")}
          </h3>
          <button
            onClick={onClose}
            disabled={isCreating}
            aria-label={t("common.close")}
            className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-1 rounded-full transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <input
            ref={nameInputRef}
            type="text"
            value={newFolderName}
            onChange={(e) => {
              setNewFolderName(e.target.value);
            }}
            disabled={isCreating}
            aria-label={t("drive.folder_name_placeholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleCreate();
              }
            }}
            className="w-full bg-gray-100 dark:bg-[#25262a] hover:bg-gray-200/70 dark:hover:bg-[#2c2d32] focus:bg-gray-200 dark:focus:bg-[#2c2d32] text-gray-900 dark:text-white text-sm rounded-xl px-4 py-3 outline-none transition-all duration-300 placeholder:text-gray-400 dark:placeholder:text-gray-500"
            placeholder={t("drive.folder_name_placeholder")}
            spellCheck={false}
          />
        </div>

        <div className="flex items-center justify-end gap-3 mt-2">
          <button
            onClick={onClose}
            disabled={isCreating}
            className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
          >
            {t("menu.cancel")}
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating || !newFolderName.trim()}
            className="px-5 py-2.5 text-sm font-medium text-white bg-brand-primary hover:bg-blue-600 rounded-xl shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isCreating ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : (
              <FolderPlus className="w-4 h-4" />
            )}
            <span>{t("menu.create")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
