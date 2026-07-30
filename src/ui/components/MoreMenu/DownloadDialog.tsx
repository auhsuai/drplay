import { X, Download, Loader2 } from 'lucide-react';

interface DownloadDialogProps {
  show: boolean;
  isDownloadingFile: boolean;
  downloadFileName: string;
  setDownloadFileName: (name: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  t: import('i18next').TFunction;
}

export function DownloadDialog({
  show,
  isDownloadingFile,
  downloadFileName,
  setDownloadFileName,
  onClose,
  onConfirm,
  t
}: DownloadDialogProps) {
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={e => e.stopPropagation()}>
      <div className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">{t('menu.download_title', 'Download File')}</h3>
          <button 
            onClick={() => !isDownloadingFile && onClose()}
            disabled={isDownloadingFile}
            className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-1 rounded-full transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('menu.file_name', 'File Name')}
          </label>
          <input
            type="text"
            value={downloadFileName}
            onChange={(e) => setDownloadFileName(e.target.value)}
            disabled={isDownloadingFile}
            className="w-full bg-gray-100 dark:bg-[#25262a] hover:bg-gray-200/70 dark:hover:bg-[#2c2d32] focus:bg-gray-200 dark:focus:bg-[#2c2d32] text-gray-900 dark:text-white text-sm rounded-xl px-4 py-3 outline-none transition-all duration-300 placeholder:text-gray-400 dark:placeholder:text-gray-500"
            placeholder={t('menu.file_name', 'File Name')}
            autoFocus
          />
        </div>
        
        <div className="flex items-center justify-end gap-3 mt-2">
          <button
            onClick={() => onClose()}
            disabled={isDownloadingFile}
            className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
          >
            {t('menu.cancel', 'Cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={isDownloadingFile || !downloadFileName.trim()}
            className="px-5 py-2.5 text-sm font-medium text-white bg-[#4285F4] hover:bg-blue-600 rounded-xl shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/30 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isDownloadingFile ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span>{isDownloadingFile ? t('menu.downloading', 'Downloading...') : t('menu.confirm_download', 'Confirm')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
