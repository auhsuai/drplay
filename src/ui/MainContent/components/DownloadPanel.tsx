import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  File,
  Folder,
  LoaderCircle,
  X,
} from "lucide-react";
import { formatBytes } from "../../../utils/formatBytes";
import {
  buildDownloadTree,
  folderSelectionState,
  type DownloadTreeNode,
} from "../../../utils/downloadPanelTree";
import type { BulkDownloadPlan } from "../../../utils/folderDownload";
import type { BulkFileState } from "../../../hooks/useBulkDownload";

/**
 * Download panel: the file/folder list behind the floating button and
 * the selection toolbar's Download action.
 *
 * - Preview (before the job starts): the scanned plan — folders expand
 *   into their file tree (reusing `scanFolderTree` via
 *   `expandSelectionToPlan`), every folder is counted by the FILES
 *   inside it, never by folders. Tick/untick files or whole folders,
 *   select/clear all, then Download starts the job with only the ticked
 *   files. The rename-file field is deliberately gone: this panel shows
 *   the FILE COUNT instead.
 * - Running (after the job starts): the same tree with a live sky-blue
 *   bar under each downloading row (its width is the file's %), a
 *   per-file cancel button, and a cancel-the-whole-job button. Cancelling
 *   one file lets the rest keep going. Closing the panel never stops the
 *   job — the floating button reopens it while the job runs.
 *
 * The panel adds no download path: preview/start/cancel all go through
 * `useBulkDownload`, which reuses the Step 1 Rust streamer.
 */
interface DownloadPanelProps {
  open: boolean;
  onClose: () => void;
  isDownloading: boolean;
  /** Scanned-but-not-started plan (preview mode). */
  previewPlan: BulkDownloadPlan | null;
  isPreviewing: boolean;
  previewError: string | null;
  /** Live per-file states (running mode). */
  fileStates: BulkFileState[];
  /** Ticked file indices into the preview plan's `files` array. */
  selectedIndices: ReadonlySet<number>;
  onToggleFile: (fileIndex: number) => void;
  onToggleFolder: (fileIndices: number[]) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onDownloadSelected: () => void;
  onCancelJob: () => void;
  onCancelFile: (fileIndex: number) => void;
  t: TFunction;
}

export function DownloadPanel({
  open,
  onClose,
  isDownloading,
  previewPlan,
  isPreviewing,
  previewError,
  fileStates,
  selectedIndices,
  onToggleFile,
  onToggleFolder,
  onSelectAll,
  onSelectNone,
  onDownloadSelected,
  onCancelJob,
  onCancelFile,
  t,
}: DownloadPanelProps) {
  // Folders start expanded; collapsing is per-folder and remembered
  // while the panel stays mounted.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const treeFiles = useMemo(
    () =>
      isDownloading
        ? fileStates.map((s) => s.planned)
        : (previewPlan?.files ?? []),
    [isDownloading, fileStates, previewPlan],
  );
  const stateByIndex = useMemo(() => {
    const map = new Map<number, BulkFileState>();
    fileStates.forEach((s, i) => map.set(i, s));
    return map;
  }, [fileStates]);
  const tree = useMemo(() => buildDownloadTree(treeFiles), [treeFiles]);

  const doneCount = fileStates.filter((s) => s.status === "done").length;
  const totalCount = isDownloading
    ? fileStates.length
    : (previewPlan?.files.length ?? 0);
  const selectedCount = isDownloading ? doneCount : selectedIndices.size;

  if (!open) return null;

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderNodes = (
    nodes: DownloadTreeNode[],
    depth: number,
  ): React.ReactNode => (
    <ul className={depth === 0 ? "" : "pl-4"}>
      {nodes.map((node) => {
        if (node.kind === "file") {
          const state = isDownloading
            ? stateByIndex.get(node.fileIndex)
            : undefined;
          const percent = state?.percent;
          const barWidth =
            state?.status === "done"
              ? 100
              : state?.status === "verifying"
                ? 100
                : (percent ?? 0);
          const cancellable =
            isDownloading &&
            state !== undefined &&
            (state.status === "queued" ||
              state.status === "downloading" ||
              state.status === "verifying");
          return (
            <li key={node.key} className="relative">
              <div className="flex items-center gap-2 px-3 py-2">
                {!isDownloading && (
                  <input
                    type="checkbox"
                    aria-label={node.name}
                    checked={selectedIndices.has(node.fileIndex)}
                    onChange={() => {
                      onToggleFile(node.fileIndex);
                    }}
                    className="w-4 h-4 shrink-0 accent-blue-600"
                  />
                )}
                <File className="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <span
                  className="flex-1 min-w-0 truncate text-sm text-gray-900 dark:text-white"
                  title={node.name}
                >
                  {node.name}
                </span>
                {state?.planned.file.size !== undefined && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    {formatBytes(state.planned.file.size)}
                  </span>
                )}
                {state?.status === "done" && (
                  <Check
                    aria-hidden="true"
                    className="w-4 h-4 shrink-0 text-green-600 dark:text-green-400"
                  />
                )}
                {state?.status === "downloading" && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    {percent !== undefined
                      ? `${String(percent)}%`
                      : t("menu.downloading")}
                  </span>
                )}
                {state?.status === "verifying" && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    {t("menu.download_verifying")}
                  </span>
                )}
                {state?.status === "cancelled" && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    {t("menu.bulk_download_cancelled")}
                  </span>
                )}
                {cancellable && (
                  <button
                    type="button"
                    aria-label={t("menu.download_panel_cancel_file")}
                    onClick={() => {
                      onCancelFile(node.fileIndex);
                    }}
                    className="p-1 rounded-full text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              {state?.status === "failed" && state.errorMessage && (
                <p className="px-3 pb-2 -mt-1 text-xs text-red-600 dark:text-red-400">
                  {state.errorMessage}
                </p>
              )}
              {/* Sky-blue progress bar under the row's bottom edge. */}
              {state !== undefined &&
                (state.status === "downloading" ||
                  state.status === "verifying" ||
                  state.status === "done") &&
                barWidth > 0 && (
                  <div
                    aria-hidden="true"
                    className="absolute bottom-0 left-0 h-[3px] bg-sky-500 transition-all duration-200"
                    style={{ width: `${String(barWidth)}%` }}
                  />
                )}
            </li>
          );
        }

        const expanded = !collapsed.has(node.key);
        const selection = folderSelectionState(
          node.fileIndices,
          selectedIndices,
        );
        return (
          <li key={node.key}>
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                aria-label={
                  expanded
                    ? t("menu.download_panel_collapse", { name: node.name })
                    : t("menu.download_panel_expand", { name: node.name })
                }
                aria-expanded={expanded}
                onClick={() => {
                  toggleCollapsed(node.key);
                }}
                className="p-0.5 rounded text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors shrink-0"
              >
                {expanded ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>
              {!isDownloading && (
                <input
                  type="checkbox"
                  aria-label={node.name}
                  checked={selection === "all"}
                  ref={(el) => {
                    if (el) el.indeterminate = selection === "some";
                  }}
                  onChange={() => {
                    onToggleFolder(node.fileIndices);
                  }}
                  className="w-4 h-4 shrink-0 accent-blue-600"
                />
              )}
              <Folder className="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400" />
              <span
                className="flex-1 min-w-0 truncate text-sm font-medium text-gray-900 dark:text-white"
                title={node.name}
              >
                {node.name}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                {t("menu.download_panel_files", {
                  count: node.fileIndices.length,
                })}
              </span>
            </div>
            {expanded && renderNodes(node.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  const skippedCount =
    (previewPlan?.skipped.length ?? 0) + (previewPlan?.unavailable.length ?? 0);

  return (
    <section
      role="dialog"
      aria-label={t("menu.download_panel_title")}
      className="absolute right-4 bottom-4 z-40 w-[min(92vw,26rem)] max-h-[70%] flex flex-col rounded-2xl bg-white dark:bg-[#1a1b1e] shadow-2xl border border-gray-200 dark:border-white/10 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <Download className="w-5 h-5 shrink-0 text-brand-primary" />
        <h2 className="flex-1 min-w-0 truncate text-base font-bold text-gray-900 dark:text-white">
          {t("menu.download_panel_title")}
        </h2>
        <button
          type="button"
          aria-label={t("menu.download_panel_close")}
          onClick={onClose}
          className="p-1 rounded-full text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors shrink-0"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <p className="px-4 pb-2 text-sm text-gray-600 dark:text-gray-300">
        {t("menu.download_panel_count", {
          selected: selectedCount,
          count: totalCount,
        })}
      </p>

      {!isDownloading && previewPlan?.truncated && (
        <p
          role="status"
          className="px-4 pb-2 text-xs text-amber-600 dark:text-amber-400"
        >
          {t("menu.download_panel_truncated")}
        </p>
      )}
      {!isDownloading && skippedCount > 0 && (
        <p className="px-4 pb-2 text-xs text-gray-500 dark:text-gray-400">
          {t("menu.download_panel_skipped", { count: skippedCount })}
        </p>
      )}

      {!isDownloading && (
        <div className="flex items-center gap-4 px-4 pb-2">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={isPreviewing || totalCount === 0}
            className="text-sm font-medium text-brand-primary hover:underline disabled:opacity-50 disabled:no-underline"
          >
            {t("menu.download_panel_select_all")}
          </button>
          <button
            type="button"
            onClick={onSelectNone}
            disabled={isPreviewing || totalCount === 0}
            className="text-sm font-medium text-brand-primary hover:underline disabled:opacity-50 disabled:no-underline"
          >
            {t("menu.download_panel_clear_all")}
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {isPreviewing ? (
          <p
            role="status"
            className="flex items-center gap-2 px-4 py-6 text-sm text-gray-500 dark:text-gray-400"
          >
            <LoaderCircle className="w-4 h-4 animate-spin" />
            {t("menu.download_panel_scanning")}
          </p>
        ) : previewError ? (
          <p
            role="alert"
            className="px-4 py-6 text-sm text-red-600 dark:text-red-400"
          >
            {previewError}
          </p>
        ) : totalCount === 0 ? (
          <p
            role="status"
            className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400"
          >
            {t("menu.download_panel_empty")}
          </p>
        ) : (
          renderNodes(tree, 0)
        )}
      </div>

      <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-gray-200 dark:border-white/10">
        {isDownloading ? (
          <>
            <button
              type="button"
              onClick={onCancelJob}
              className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-xl shadow-md shadow-red-500/20 transition-all"
            >
              {t("menu.download_panel_cancel_job")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors"
            >
              {t("menu.download_panel_close")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors"
            >
              {t("menu.cancel")}
            </button>
            <button
              type="button"
              onClick={onDownloadSelected}
              disabled={
                isPreviewing || selectedIndices.size === 0 || !previewPlan
              }
              className="px-4 py-2 text-sm font-medium text-white bg-brand-primary hover:bg-blue-600 rounded-xl shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/30 transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              <span>{t("menu.confirm_download")}</span>
            </button>
          </>
        )}
      </div>
    </section>
  );
}
