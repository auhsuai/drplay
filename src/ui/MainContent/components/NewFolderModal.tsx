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

  // Focus the name field when the modal opens (replaces the autoFocus prop,
  // which jsx-a11y/no-autofocus rejects).
  useEffect(() => {
    if (isOpen) nameInputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreate = async () => {
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
    await onCreate(name);
    setNewFolderName(""); // Reset only on success
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
      <div className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">
            {t("drive.new_folder_title")}
          </h3>
          <button
            onClick={onClose}
            disabled={isCreating}
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
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void handleCreate();
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
            onClick={() => {
              void handleCreate();
            }}
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
