import { X, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../../components/ModalShell";

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

  if (!isOpen) return null;

  return (
    <ModalShell
      labelledById="bulk-delete-title"
      onClose={onClose}
      closeDisabled={isOperating}
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
    </ModalShell>
  );
}
