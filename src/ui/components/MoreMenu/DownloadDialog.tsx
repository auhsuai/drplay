import { useEffect, useRef } from "react";
import { X, Download, Pause, Play } from "lucide-react";
import { formatBytes } from "../../../utils/formatBytes";
import type { DownloadProgressState } from "../../../utils/fileDownload";

interface DownloadDialogProps {
  show: boolean;
  isDownloadingFile: boolean;
  /** Display name of the single file (read-only now: the rename field
   * was removed — confirming a download shows the FILE COUNT instead).
   * The name is still the pre-filled default (`title - artist`) that
   * `executeDownload` saves under; it is just no longer editable here. */
  downloadFileName: string;
  onClose: () => void;
  onConfirm: () => void;
  t: import("i18next").TFunction;
  /** Live progress while a download runs; `null` before it starts. */
  downloadProgress?: DownloadProgressState | null;
  downloadPaused?: boolean;
  onCancelDownload?: () => void;
  onPauseDownload?: () => void;
  onResumeDownload?: () => void;
}

export function DownloadDialog({
  show,
  isDownloadingFile,
  downloadFileName,
  onClose,
  onConfirm,
  t,
  downloadProgress = null,
  downloadPaused = false,
  onCancelDownload,
  onPauseDownload,
  onResumeDownload,
}: DownloadDialogProps) {
  // Focus the dialog itself when it opens (the rename input this used to
  // focus is gone), and remember the invoker so focus returns on
  // close/unmount (APG dialog-modal). Deliberately ONE effect with hooks
  // above the early return: the invoker snapshot must be taken BEFORE
  // focus moves into the dialog.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!show) return;
    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
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
  }, [show]);

  // Escape cancels the dialog (same guard as X/Cancel: ignored while a
  // download is in flight). Window CAPTURE: as the innermost overlay the
  // dialog must swallow the press before the document (menu) and window
  // (drawer) listeners run — including while busy, so no layer behind a modal
  // reacts to Esc (APG dialog-modal). Capture on window also fires for events
  // dispatched on window itself, so existing window-target tests stay valid.
  useEffect(() => {
    if (!show) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!isDownloadingFile) onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [show, onClose, isDownloadingFile]);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="download-title"
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200 outline-none"
      >
        <div className="flex items-center justify-between">
          <h3
            id="download-title"
            className="text-lg font-bold text-gray-900 dark:text-white"
          >
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

        {/* No rename field anymore: a single-file download shows the
            file name (read-only) and the file count — 1 file — instead. */}
        <div className="flex flex-col gap-1">
          <p
            className="text-sm font-medium text-gray-900 dark:text-white truncate"
            title={downloadFileName}
          >
            {downloadFileName}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("menu.download_panel_files", { count: 1 })}
          </p>
        </div>

        {isDownloadingFile && downloadProgress && (
          <div
            className="flex flex-col gap-2"
            role="status"
            aria-label={t("menu.downloading")}
          >
            <div className="flex items-center justify-between text-sm text-gray-700 dark:text-gray-300">
              <span>
                {downloadProgress.stage === "verifying"
                  ? t("menu.download_verifying")
                  : downloadPaused
                    ? t("menu.download_paused")
                    : t("menu.downloading")}
              </span>
              <span>
                {downloadProgress.percent !== undefined
                  ? `${String(downloadProgress.percent)}%`
                  : formatBytes(downloadProgress.downloaded)}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-gray-200 dark:bg-[#2c2d32] overflow-hidden">
              <div
                className="h-full bg-brand-primary rounded-full transition-all duration-200"
                style={{
                  width:
                    downloadProgress.percent !== undefined
                      ? `${String(downloadProgress.percent)}%`
                      : "100%",
                }}
              />
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {downloadProgress.total !== undefined
                ? `${formatBytes(downloadProgress.downloaded)} / ${formatBytes(downloadProgress.total)}`
                : formatBytes(downloadProgress.downloaded)}
              {downloadProgress.speedBytesPerSec !== undefined &&
                downloadProgress.stage === "downloading" &&
                !downloadPaused &&
                ` · ${formatBytes(downloadProgress.speedBytesPerSec)}/s`}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 mt-2">
          {isDownloadingFile ? (
            <>
              <button
                onClick={() => {
                  if (downloadPaused) {
                    onResumeDownload?.();
                  } else {
                    onPauseDownload?.();
                  }
                }}
                className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors flex items-center gap-2"
              >
                {downloadPaused ? (
                  <Play className="w-4 h-4" />
                ) : (
                  <Pause className="w-4 h-4" />
                )}
                <span>
                  {downloadPaused
                    ? t("menu.download_resume")
                    : t("menu.download_pause")}
                </span>
              </button>
              <button
                onClick={() => {
                  onCancelDownload?.();
                }}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-xl shadow-md shadow-red-500/20 transition-all"
              >
                {t("menu.cancel")}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  onClose();
                }}
                className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors"
              >
                {t("menu.cancel")}
              </button>
              <button
                onClick={onConfirm}
                disabled={!downloadFileName.trim()}
                className="px-5 py-2.5 text-sm font-medium text-white bg-brand-primary hover:bg-blue-600 rounded-xl shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/30 transition-all flex items-center gap-2 disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                <span>{t("menu.confirm_download")}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
