
import { Square, CheckSquare, FolderOutput, Trash2, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SelectionToolbarProps {
  isSelectionMode: boolean;
  selectedCount: number;
  totalCount: number;
  isBulkOperating: boolean;
  onToggleSelectAll: () => void;
  onBulkMoveClick: () => void;
  onBulkDeleteClick: () => void;
}

export function SelectionToolbar({
  isSelectionMode,
  selectedCount,
  totalCount,
  isBulkOperating,
  onToggleSelectAll,
  onBulkMoveClick,
  onBulkDeleteClick
}: SelectionToolbarProps) {
  const { t } = useTranslation();

  if (!isSelectionMode) return null;

  return (
    <div className="flex items-center gap-3 animate-in fade-in slide-in-from-right-4 duration-300">
      <button
        onClick={onToggleSelectAll}
        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95"
      >
        {selectedCount === totalCount ? <Square className="w-4 h-4" /> : <CheckSquare className="w-4 h-4" />}
        <span className="hidden sm:inline">{t('drive.select_all', 'Chọn tất cả')}</span>
      </button>
      
      <button
        onClick={onBulkMoveClick}
        disabled={selectedCount === 0 || isBulkOperating}
        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <FolderOutput className="w-4 h-4" />
        <span className="hidden sm:inline">{t('drive.bulk_move', 'Di chuyển')}</span>
      </button>

      <button
        onClick={onBulkDeleteClick}
        disabled={selectedCount === 0 || isBulkOperating}
        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isBulkOperating ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        <span className="hidden sm:inline">{t('drive.delete', 'Xóa')}</span>
      </button>
    </div>
  );
}
