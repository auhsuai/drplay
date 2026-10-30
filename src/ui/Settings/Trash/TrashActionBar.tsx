import { Trash2, RefreshCw, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface TrashActionBarProps {
  selectedCount: number;
  itemCount: number;
  isBulkActioning: boolean;
  isEmptying: boolean;
  onBulkRestore: () => Promise<void>;
  onBulkDelete: () => void;
  onEmptyTrash: () => void;
  onClose: () => void;
}

// Footer actions for the trash dialog: bulk restore/delete for the current
// selection, or Cancel + Empty trash when nothing is selected. The bar only
// knows counts (not ids) and never runs a mutation itself.
export function TrashActionBar({
  selectedCount,
  itemCount,
  isBulkActioning,
  isEmptying,
  onBulkRestore,
  onBulkDelete,
  onEmptyTrash,
  onClose,
}: TrashActionBarProps) {
  const { t } = useTranslation();

  return (
    <div className="px-6 py-4 flex items-center justify-between bg-gray-50/50 dark:bg-[#1a1b1e]/50 shrink-0">
      {selectedCount > 0 ? (
        <>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {selectedCount} {t("common.selected")}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                void onBulkRestore();
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
              onClick={onBulkDelete}
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
            {itemCount > 0
              ? `${String(itemCount)} ${t("settings.items_in_trash")}`
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
              onClick={onEmptyTrash}
              disabled={itemCount === 0 || isEmptying}
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
  );
}
