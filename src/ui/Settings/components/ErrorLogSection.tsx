import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLiveQuery } from "dexie-react-hooks";
import {
  captureError,
  clearErrorLogs,
  exportErrorLogsSanitized,
  exportErrorLogsSanitizedForDate,
  groupLogsByDate,
  type ErrorLogEntry,
} from "../../../utils/errorLog";
import { db } from "../../../db/db";
import { copyToClipboard } from "../../../utils/copyToClipboard";
import { showErrorToast } from "../../../utils/simpleToast";
import { ScrollText } from "lucide-react";

const ERROR_LOG_SECTION_MODULE = "ErrorLogSection";

const LEVEL_BADGE: Record<ErrorLogEntry["level"], string> = {
  error: "bg-red-500/15 text-red-500 dark:text-red-400",
  warn: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  info: "bg-blue-500/15 text-blue-500 dark:text-blue-400",
};

function formatTs(ts: number): string {
  // Guard against bad input (slice reuses Slice1 shape; defensive parse).
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function LogEntryCard({ entry }: { entry: ErrorLogEntry }) {
  const { t } = useTranslation();
  // SECURITY: each entry is its own text node (<div>/<pre>), mapped from the
  // array. Raw messages are NEVER concatenated into a single HTML blob, and
  // dangerouslySetInnerHTML is NEVER used — preventing log forging via
  // injected newlines. This exact card is reused in both the date-group view
  // and the day-detail view.
  return (
    <div
      key={entry.id}
      className="border-b border-gray-200 dark:border-[#2A2A2A] pb-3 last:border-b-0 last:pb-0"
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full ${LEVEL_BADGE[entry.level]}`}
        >
          {entry.level}
        </span>
        <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
          {entry.source}
        </span>
        <span className="text-xs text-gray-400">{formatTs(entry.ts)}</span>
      </div>
      <pre className="whitespace-pre-wrap break-all text-sm text-gray-800 dark:text-gray-200 font-sans m-0 select-text">
        {entry.message}
      </pre>
      {entry.stack ? (
        <details className="mt-1">
          <summary className="text-xs text-gray-400 cursor-pointer select-none">
            {t("settings.error_log_stack") || "Stack trace"}
          </summary>
          <pre className="whitespace-pre-wrap break-all text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono m-0 select-text">
            {entry.stack}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function ErrorLogSection() {
  const { t } = useTranslation();
  // useLiveQuery subscribes to db.errorLogs writes (captureError() adds rows
  // while this section is mounted), so new/cleared logs appear WITHOUT a
  // remount — the one-shot useEffect+getErrorLogs version went stale.
  // Querier never rejects: on failure it reports via captureError and falls
  // back to [] (useLiveQuery itself rethrows querier errors on render).
  const logs = useLiveQuery(
    () =>
      db.errorLogs
        .orderBy("ts")
        .reverse()
        .toArray()
        .catch((err: unknown) => {
          captureError({
            level: "error",
            source: ERROR_LOG_SECTION_MODULE,
            message: `failed-to-load-logs: ${err instanceof Error ? err.message : String(err)}`,
          });
          return [];
        }),
    [],
  );
  // undefined until the first query resolves → same "Loading..." gate as the
  // old mount-only fetch (later live re-runs keep the last value, no flicker).
  const loading = logs === undefined;
  const logList = logs ?? [];
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      setHasSelection(text.length > 0 && el.contains(sel!.anchorNode as Node));
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const handleCopy = async () => {
    if (logList.length === 0 || busy) return;
    setBusy(true);
    try {
      const sel = window.getSelection();
      const selectedText = sel?.toString().trim() ?? "";
      const hasSelection =
        selectedText.length > 0 &&
        containerRef.current?.contains(sel!.anchorNode as Node);
      const text = hasSelection
        ? selectedText
        : selectedDate
          ? await exportErrorLogsSanitizedForDate(selectedDate)
          : await exportErrorLogsSanitized();
      const ok = await copyToClipboard(text);
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        showErrorToast(
          t("settings.error_log_copy_error") || "Could not copy to clipboard.",
        );
      }
    } catch (err) {
      captureError({
        level: "error",
        source: ERROR_LOG_SECTION_MODULE,
        message: `failed-to-export-copy-logs: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(
        t("settings.error_log_copy_error") || "Could not copy to clipboard.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await clearErrorLogs();
    } catch (err) {
      captureError({
        level: "error",
        source: ERROR_LOG_SECTION_MODULE,
        message: `failed-to-clear-logs: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(
        t("settings.error_log_clear_error") || "Failed to clear logs.",
      );
    } finally {
      setBusy(false);
    }
  };

  const actionButtons = (
    <div className="flex items-center gap-2 shrink-0 -mt-[2px]">
      <button
        onClick={handleCopy}
        disabled={logList.length === 0 || busy}
        className="px-5 py-2.5 bg-[#4285F4] hover:bg-[#3367d6] text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 min-w-[160px] justify-center"
      >
        <ScrollText className="w-4 h-4" />
        {copied
          ? t("settings.error_log_copied") || "Copied!"
          : hasSelection
            ? t("settings.error_log_copy_selected") || "Copy Selected"
            : t("settings.error_log_copy") || "Copy Report"}
      </button>
      <button
        onClick={handleClear}
        disabled={logList.length === 0 || busy}
        className="px-5 py-2.5 bg-[#4285F4] hover:bg-[#3367d6] text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
      >
        {t("settings.error_log_clear") || "Clear Log"}
      </button>
    </div>
  );

  return (
    <div ref={containerRef} className="flex flex-col gap-2 mt-6 mb-8">
      <h2 className="text-sm font-bold text-[#4285F4] uppercase tracking-wider mb-2">
        {t("settings.error_log_title") || "Error Log"}
      </h2>

      {selectedDate && (
        <div className="flex items-end justify-between">
          <button
            onClick={() => setSelectedDate(null)}
            className="text-sm font-semibold text-gray-800 dark:text-gray-200 hover:text-[#4285F4] transition-colors py-2.5"
          >
            ← {t("settings.error_log_back") || "Back"}
          </button>
          {actionButtons}
        </div>
      )}

      <div className="max-h-80 overflow-y-auto">
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("loading") || "Loading..."}
          </p>
        ) : logList.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("settings.error_log_empty") ||
              "No errors have been recorded yet."}
          </p>
        ) : selectedDate === null ? (
          <div className="flex flex-col gap-2">
            {groupLogsByDate(logList).map((group) => (
              <button
                key={group.dateKey}
                onClick={() => setSelectedDate(group.dateKey)}
                className="flex items-center justify-between w-full text-left px-3 py-2.5 rounded-lg bg-white dark:bg-[#222] hover:bg-gray-100 dark:hover:bg-[#2E2E2E] border border-gray-200 dark:border-[#2A2A2A] transition-all"
              >
                <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                  {group.dateKey}
                </span>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-200 dark:bg-[#333] text-gray-600 dark:text-gray-300">
                  {t("settings.error_log_count", {
                    count: group.entries.length,
                  }) || `${group.entries.length} errors`}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3 select-text">
            {groupLogsByDate(logList)
              .find((g) => g.dateKey === selectedDate)
              ?.entries.map((entry) => (
                <LogEntryCard key={entry.id} entry={entry} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
