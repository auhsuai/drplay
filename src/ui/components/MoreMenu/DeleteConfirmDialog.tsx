import { Loader2, Trash2 } from 'lucide-react';
import { DriveItem } from '../../../App';

interface DeleteConfirmDialogProps {
  show: boolean;
  isDeleting: boolean;
  driveItem: DriveItem | null;
  onClose: () => void;
  onConfirm: () => void;
  t: import('i18next').TFunction;
}

export function DeleteConfirmDialog({
  show,
  isDeleting,
  driveItem,
  onClose,
  onConfirm,
  t
}: DeleteConfirmDialogProps) {
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={() => !isDeleting && onClose()}>
      <div className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-sm shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex flex-col gap-2">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">
            {t('drive.confirm_delete', 'Move to Trash?')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {driveItem?.title}
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 mt-2">
          <button
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
          >
            {t('menu.cancel', 'Cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-xl shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            <span>{t('drive.delete', 'Delete')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
