import { useEffect, useRef } from "react";
import { X, Download, LoaderCircle } from "lucide-react";
import { DownloadProgress } from "../DownloadProgress";

interface DownloadDialogProps {
  show: boolean;
  isDownloadingFile: boolean;
  downloadFileName: string;
  setDownloadFileName: (name: string) => void;
  downloadProgress: { downloaded: number; total: number | null } | null;
  onClose: () => void;
  onConfirm: () => void;
  t: import("i18next").TFunction;
}

export function DownloadDialog({
  show,
  isDownloadingFile,
  downloadFileName,
  setDownloadFileName,
  downloadProgress,
  onClose,
  onConfirm,
  t,
}: DownloadDialogProps) {
  // Focus the file-name field when the dialog opens (replaces the autoFocus
  // prop, which jsx-a11y/no-autofocus rejects). Hooks stay above the early
  // return so they always run in the same order.
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (show) nameInputRef.current?.focus();
  }, [show]);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <div className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">
            {t("menu.download_title")}
          </h3>
          <button
            onClick={() => {
              if (!isDownloadingFile) onClose();
            }}
            disabled={isDownloadingFile}
            className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-1 rounded-full transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t("menu.file_name")}
          </label>
          <input
            ref={nameInputRef}
            type="text"
            value={downloadFileName}
            onChange={(e) => {
              setDownloadFileName(e.target.value);
            }}
            disabled={isDownloadingFile}
            className="w-full bg-gray-100 dark:bg-[#25262a] hover:bg-gray-200/70 dark:hover:bg-[#2c2d32] focus:bg-gray-200 dark:focus:bg-[#2c2d32] text-gray-900 dark:text-white text-sm rounded-xl px-4 py-3 outline-none transition-all duration-300 placeholder:text-gray-400 dark:placeholder:text-gray-500"
            placeholder={t("menu.file_name")}
          />
        </div>

        <div className="flex items-center justify-end gap-3 mt-2">
          {isDownloadingFile && downloadProgress && (
            <div className="flex-1">
              <DownloadProgress
                downloaded={downloadProgress.downloaded}
                total={downloadProgress.total}
              />
            </div>
          )}
          <button
            onClick={() => {
              onClose();
            }}
            disabled={isDownloadingFile}
            className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
          >
            {t("menu.cancel")}
          </button>
          <button
            onClick={onConfirm}
            disabled={isDownloadingFile || !downloadFileName.trim()}
            className="px-5 py-2.5 text-sm font-medium text-white bg-brand-primary hover:bg-blue-600 rounded-xl shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/30 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            {isDownloadingFile ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span>
              {isDownloadingFile
                ? t("menu.downloading")
                : t("menu.confirm_download")}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
