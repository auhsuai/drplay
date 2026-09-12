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
      className="flex flex-wrap items-center gap-3 rounded-xl bg-gray-50 dark:bg-[#2a2b2f] px-3 py-2"
    >
      <span className="text-sm text-gray-600 dark:text-gray-300">
        {t("queue.selected_count", { count: selectedCount })}
      </span>

      <button
        type="button"
        onClick={onToggleSelectAll}
        className="text-sm font-medium text-brand-primary hover:underline"
      >
        {allSelected ? t("queue.unselect_all") : t("queue.select_all")}
      </button>

      <button
        type="button"
        data-testid="queue-remove-selected"
        onClick={onRemove}
        disabled={selectedCount === 0}
        className="ml-auto text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t("queue.remove_selected", { count: selectedCount })}
      </button>

      <button
        type="button"
        onClick={onExit}
        className="text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        {t("queue.exit_selection")}
      </button>
    </div>
  );
}
