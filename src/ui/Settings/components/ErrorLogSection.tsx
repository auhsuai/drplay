import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getErrorLogs,
  clearErrorLogs,
  exportErrorLogsSanitized,
  exportErrorLogsSanitizedForDate,
  groupLogsByDate,
  type ErrorLogEntry,
} from "../../../utils/errorLog";
import { copyToClipboard } from "../../../utils/copyToClipboard";
import { showErrorToast } from "../../../utils/simpleToast";
import { ScrollText } from "lucide-react";

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
      <pre className="whitespace-pre-wrap break-all text-sm text-gray-800 dark:text-gray-200 font-sans m-0">
        {entry.message}
      </pre>
      {entry.stack ? (
        <details className="mt-1">
          <summary className="text-xs text-gray-400 cursor-pointer select-none">
            {t("settings.error_log_stack") || "Stack trace"}
          </summary>
          <pre className="whitespace-pre-wrap break-all text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono m-0">
            {entry.stack}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function ErrorLogSection() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<ErrorLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getErrorLogs();
        if (!cancelled) setLogs(data);
      } catch (err) {
        console.error("[ErrorLogSection] failed to load logs", {
          module: "ErrorLogSection",
          timestamp: new Date().toISOString(),
          reason: err instanceof Error ? err.message : "unknown",
        });
        if (!cancelled) setLogs([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopy = async () => {
    if (logs.length === 0 || busy) return;
    setBusy(true);
    try {
      const text = selectedDate
        ? await exportErrorLogsSanitizedForDate(selectedDate)
        : await exportErrorLogsSanitized();
      const ok = await copyToClipboard(text);
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        showErrorToast(t("settings.error_log_copy_error") || "Could not copy to clipboard.");
      }
    } catch (err) {
      console.error("[ErrorLogSection] failed to export/copy logs", {
        module: "ErrorLogSection",
        timestamp: new Date().toISOString(),
        reason: err instanceof Error ? err.message : "unknown",
      });
      showErrorToast(t("settings.error_log_copy_error") || "Could not copy to clipboard.");
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await clearErrorLogs();
      setLogs([]);
    } catch (err) {
      console.error("[ErrorLogSection] failed to clear logs", {
        module: "ErrorLogSection",
        timestamp: new Date().toISOString(),
        reason: err instanceof Error ? err.message : "unknown",
      });
      showErrorToast(t("settings.error_log_clear_error") || "Failed to clear logs.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 mt-6 mb-8">
      <h2 className="text-sm font-bold text-[#4285F4] uppercase tracking-wider mb-2">
        {t("settings.error_log_title") || "Error Log"}
      </h2>

      <div className="flex items-center justify-between py-2">
        <p className="text-xs text-gray-500 dark:text-gray-400 max-w-[520px]">
          {t("settings.error_log_note") ||
            "These logs are filtered to remove personal information (IDs, tokens, links) before they leave your device."}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleCopy}
            disabled={logs.length === 0 || busy}
            className="px-5 py-2.5 rounded-xl bg-[#4285F4] hover:bg-[#3367d6] text-white text-sm font-semibold transition-all transform active:scale-[0.97] shadow-[0_4px_12px_rgba(66,133,244,0.3)] hover:shadow-[0_6px_16px_rgba(66,133,244,0.4)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <ScrollText className="w-4 h-4" />
            {copied
              ? t("settings.error_log_copied") || "Copied!"
              : t("settings.error_log_copy") || "Copy Report"}
          </button>
          <button
            onClick={handleClear}
            disabled={logs.length === 0 || busy}
            className="px-5 py-2.5 rounded-xl bg-gray-200 dark:bg-[#2A2A2A] hover:bg-gray-300 dark:hover:bg-[#3A3A3A] text-gray-900 dark:text-gray-100 text-sm font-semibold transition-all transform active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {t("settings.error_log_clear") || "Clear Log"}
          </button>
        </div>
      </div>

      {selectedDate && (
        <button
          onClick={() => setSelectedDate(null)}
          className="self-start text-xs font-semibold text-[#4285F4] hover:underline flex items-center gap-1 mb-2"
        >
          ← {t("settings.error_log_back") || "Back"}
        </button>
      )}

      <div className="mt-2 rounded-xl border border-gray-200 dark:border-[#2A2A2A] bg-gray-50 dark:bg-[#1A1A1A] p-3 max-h-80 overflow-y-auto">
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("loading") || "Loading..."}
          </p>
        ) : logs.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("settings.error_log_empty") || "No errors have been recorded yet."}
          </p>
        ) : selectedDate === null ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
              {t("settings.error_log_by_date") || "Errors by day"}
            </p>
            {groupLogsByDate(logs).map((group) => (
              <button
                key={group.dateKey}
                onClick={() => setSelectedDate(group.dateKey)}
                className="flex items-center justify-between w-full text-left px-3 py-2.5 rounded-lg bg-white dark:bg-[#222] hover:bg-gray-100 dark:hover:bg-[#2E2E2E] border border-gray-200 dark:border-[#2A2A2A] transition-all"
              >
                <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
                  {group.dateKey}
                </span>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-200 dark:bg-[#333] text-gray-600 dark:text-gray-300">
                  {t("settings.error_log_count", { count: group.entries.length }) ||
                    `${group.entries.length} errors`}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groupLogsByDate(logs)
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
