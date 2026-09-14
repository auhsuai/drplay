import { Square, SquareCheckBig, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface QueueSelectionToolbarProps {
  selectedCount: number;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  onRemove: () => void;
  onExit: () => void;
}

/** Bulk-selection actions shown only while selection mode is active. */
export function QueueSelectionToolbar({
  selectedCount,
  allSelected,
  onToggleSelectAll,
  onRemove,
  onExit,
}: QueueSelectionToolbarProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="queue-selection-toolbar"
      className="flex min-w-0 flex-col gap-2 animate-in fade-in duration-300"
    >
      <div className="flex min-w-0 items-center gap-2 animate-in fade-in slide-in-from-left-4 duration-300">
        <button
          type="button"
          onClick={onExit}
          aria-label={t("queue.exit_selection")}
          title={t("queue.exit_selection")}
          className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
        >
          <X className="w-5 h-5 text-gray-700 dark:text-gray-300" />
        </button>
        <span
          role="status"
          aria-atomic="true"
          className="min-w-0 truncate px-2 py-1 font-semibold text-lg text-gray-900 dark:text-white"
        >
          {t("queue.selected_count", { count: selectedCount })}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-right-4 duration-300">
        <button
          type="button"
          onClick={onToggleSelectAll}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95"
        >
          {allSelected ? (
            <Square className="w-4 h-4" />
          ) : (
            <SquareCheckBig className="w-4 h-4" />
          )}
          <span>
            {allSelected ? t("queue.unselect_all") : t("queue.select_all")}
          </span>
        </button>

        <button
          type="button"
          data-testid="queue-remove-selected"
          onClick={onRemove}
          disabled={selectedCount === 0}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-brand-primary hover:bg-blue-600 rounded-lg transition-colors shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trash2 className="w-4 h-4" />
          <span>{t("queue.remove_selected", { count: selectedCount })}</span>
        </button>
      </div>
    </div>
  );
}
