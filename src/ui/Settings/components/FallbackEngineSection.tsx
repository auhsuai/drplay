import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { formatBytes } from "../../../utils/formatBytes";
import { showErrorToast, showSuccessToast } from "../../../utils/simpleToast";
import { captureError } from "../../../utils/errorLog";

// Optional mpv.exe fallback engine (Slice 5). The engine is NEVER required:
// libmpv is the primary engine and this section only manages the on-disk
// fallback binary that libmpv-failure can fall back to on the next process.
const FALLBACK_ENGINE_SECTION = "FallbackEngineSection";

const STATUS_COMMAND = "get_mpv_fallback_status";
const INSTALL_COMMAND = "install_mpv_fallback";

// Every invoke rejection is "<code>: <text>" (see playback_runtime/commands.rs).
const ERROR_CODE_SEPARATOR = ": ";
const UNKNOWN_ERROR_CODE = "unknown";

const SUCCESS_TOAST_MS = 3000;
const ERROR_TOAST_MS = 4000;

/**
 * Rust event: one step of an in-flight install. There is deliberately NO
 * terminal success/failure stage — the install command's return value (and its
 * rejection) is the only authority for completion. See
 * `src-tauri/src/playback_runtime/commands.rs`.
 */
export const MPV_FALLBACK_PROGRESS_EVENT = "mpv-fallback-progress";

/** Settled install state. "installed" is a claim about DISK, not about use. */
export type FallbackStage = "notInstalled" | "installed" | "invalid";
/** Which engine this process will actually use. Only "legacy" means in use. */
export type FallbackEngineKind = "libmpv" | "legacy" | "unavailable";
export type FallbackUnavailableReason =
  | "libmpvFailedNoSidecar"
  | "sidecarRequestedButMissing";
export type FallbackProgressStage =
  | "downloading"
  | "verifying"
  | "extracting"
  | "publishing";

export interface FallbackStatus {
  stage: FallbackStage;
  version?: string;
  size?: number;
  reason?: string;
  engine: FallbackEngineKind;
  unavailableReason?: FallbackUnavailableReason;
  pinnedVersion: string;
}

export interface FallbackProgress {
  stage: FallbackProgressStage;
  downloaded: number | null;
  total: number | null;
  percent: number | null;
}

interface WireError {
  /** Stable snake_case slug from the backend, or "unknown". */
  code: string;
  /** Full rejection text, appended verbatim for diagnostics. */
  raw: string;
}

const FALLBACK_STAGES: readonly FallbackStage[] = [
  "notInstalled",
  "installed",
  "invalid",
];
const ENGINE_KINDS: readonly FallbackEngineKind[] = [
  "libmpv",
  "legacy",
  "unavailable",
];
const PROGRESS_STAGES: readonly FallbackProgressStage[] = [
  "downloading",
  "verifying",
  "extracting",
  "publishing",
];
const UNAVAILABLE_REASONS: readonly FallbackUnavailableReason[] = [
  "libmpvFailedNoSidecar",
  "sidecarRequestedButMissing",
];

// Literal keys (never built from the code slug) so the extractor can see them
// and an unknown code can never render a raw key. The unions below keep every
// lookup statically checkable against the typed i18next resources.
type FallbackErrorCode =
  | "already_in_progress"
  | "asset_missing"
  | "checksum_mismatch"
  | "size_mismatch"
  | "network"
  | "http_status"
  | "entry_missing"
  | "unsafe_entry"
  | "exe_too_small"
  | "exe_too_large"
  | "version_unreadable"
  | "publish_failed"
  | "archive_unreadable"
  | "path_unavailable"
  | "unsupported_platform";

type ProgressStageKey = `settings.playback_components.stage_${FallbackProgressStage}`;
type UnavailableKey =
  | "settings.playback_components.unavailable_libmpv_failed_no_sidecar"
  | "settings.playback_components.unavailable_sidecar_requested_but_missing";
type ErrorKey = `settings.playback_components.error_${FallbackErrorCode | "generic"}`;

const GENERIC_ERROR_KEY: ErrorKey = "settings.playback_components.error_generic";

// Runtime twin of the FallbackErrorCode union: the one place a new backend
// slug has to be registered (the Record below then fails to compile until the
// matching copy key exists).
const FALLBACK_ERROR_CODES: readonly FallbackErrorCode[] = [
  "already_in_progress",
  "asset_missing",
  "checksum_mismatch",
  "size_mismatch",
  "network",
  "http_status",
  "entry_missing",
  "unsafe_entry",
  "exe_too_small",
  "exe_too_large",
  "version_unreadable",
  "publish_failed",
  "archive_unreadable",
  "path_unavailable",
  "unsupported_platform",
];

const STAGE_LABEL_KEYS: Record<FallbackProgressStage, ProgressStageKey> = {
  downloading: "settings.playback_components.stage_downloading",
  verifying: "settings.playback_components.stage_verifying",
  extracting: "settings.playback_components.stage_extracting",
  publishing: "settings.playback_components.stage_publishing",
};

const UNAVAILABLE_REASON_KEYS: Record<
  FallbackUnavailableReason,
  UnavailableKey
> = {
  libmpvFailedNoSidecar:
    "settings.playback_components.unavailable_libmpv_failed_no_sidecar",
  sidecarRequestedButMissing:
    "settings.playback_components.unavailable_sidecar_requested_but_missing",
};

// Complete on purpose: a slug added to the union above fails to compile until
// it gets user-facing copy, so no code can ever fall through to the generic
// message by accident.
const ERROR_MESSAGE_KEYS: Record<FallbackErrorCode, ErrorKey> = {
  already_in_progress: "settings.playback_components.error_already_in_progress",
  asset_missing: "settings.playback_components.error_asset_missing",
  checksum_mismatch: "settings.playback_components.error_checksum_mismatch",
  size_mismatch: "settings.playback_components.error_size_mismatch",
  network: "settings.playback_components.error_network",
  http_status: "settings.playback_components.error_http_status",
  entry_missing: "settings.playback_components.error_entry_missing",
  unsafe_entry: "settings.playback_components.error_unsafe_entry",
  exe_too_small: "settings.playback_components.error_exe_too_small",
  exe_too_large: "settings.playback_components.error_exe_too_large",
  version_unreadable: "settings.playback_components.error_version_unreadable",
  publish_failed: "settings.playback_components.error_publish_failed",
  archive_unreadable: "settings.playback_components.error_archive_unreadable",
  path_unavailable: "settings.playback_components.error_path_unavailable",
  unsupported_platform:
    "settings.playback_components.error_unsupported_platform",
};

function isOneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (allowed as readonly string[]).includes(value)
  );
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    // JSON.stringify is typed `string` but returns undefined for undefined,
    // functions and symbols; the cast documents the real runtime shape.
    const serialized = JSON.stringify(value) as string | undefined;
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

function parseWireError(value: unknown): WireError {
  const raw = describeValue(value);
  const separatorIndex = raw.indexOf(ERROR_CODE_SEPARATOR);
  if (separatorIndex <= 0) return { code: UNKNOWN_ERROR_CODE, raw };
  return { code: raw.slice(0, separatorIndex), raw };
}

function errorMessageKey(code: string): ErrorKey {
  // An unrecognized slug (backend drift, a wrapper error) must never render a
  // raw key: it degrades to the generic message plus the raw text.
  if (!isOneOf(FALLBACK_ERROR_CODES, code)) {
    return GENERIC_ERROR_KEY;
  }
  return ERROR_MESSAGE_KEYS[code];
}

/**
 * The DTO is camelCase with optional fields OMITTED when absent, so a missing
 * field is normal. Anything that is not a well-formed status (a drifted wire
 * shape, a non-Tauri invoke) is rejected instead of rendered half-parsed.
 */
function parseStatus(value: unknown): FallbackStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const stage = record["stage"];
  const engine = record["engine"];
  const pinnedVersion = record["pinnedVersion"];
  if (!isOneOf(FALLBACK_STAGES, stage)) return null;
  if (!isOneOf(ENGINE_KINDS, engine)) return null;
  if (typeof pinnedVersion !== "string") return null;

  const status: FallbackStatus = { stage, engine, pinnedVersion };
  const version = record["version"];
  if (typeof version === "string") status.version = version;
  const size = record["size"];
  if (typeof size === "number") status.size = size;
  const reason = record["reason"];
  if (typeof reason === "string") status.reason = reason;
  if (isOneOf(UNAVAILABLE_REASONS, record["unavailableReason"])) {
    status.unavailableReason = record["unavailableReason"];
  }
  return status;
}

// Fields are always present on the wire and null when unknown; a null percent
// must stay null (an indeterminate bar), never become 0.
function parseProgress(value: unknown): FallbackProgress | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const stage = record["stage"];
  if (!isOneOf(PROGRESS_STAGES, stage)) return null;
  const downloaded = record["downloaded"];
  const total = record["total"];
  const percent = record["percent"];
  return {
    stage,
    downloaded: typeof downloaded === "number" ? downloaded : null,
    total: typeof total === "number" ? total : null,
    percent: typeof percent === "number" ? percent : null,
  };
}

export function FallbackEngineSection() {
  const { t } = useTranslation();
  // null = "checking": the initial read is in flight. Initializing to
  // notInstalled would flash "Download" over a machine that already has it.
  const [status, setStatus] = useState<FallbackStatus | null>(null);
  const [statusError, setStatusError] = useState<WireError | null>(null);
  const [installError, setInstallError] = useState<WireError | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<FallbackProgress | null>(null);
  // Synchronous re-entrancy guard (mirror useSeedImport): `installing` only
  // flips after React flushes, so two clicks in one tick would otherwise reach
  // Rust twice (the second rejection would be "already_in_progress").
  const installingRef = useRef(false);

  const applyStatus = useCallback((payload: unknown) => {
    const parsed = parseStatus(payload);
    if (parsed === null) {
      const malformed: WireError = {
        code: UNKNOWN_ERROR_CODE,
        raw: `unexpected ${STATUS_COMMAND} payload`,
      };
      setStatusError(malformed);
      void captureError({
        level: "warn",
        source: FALLBACK_ENGINE_SECTION,
        message: `load-fallback-status-failed: ${malformed.raw}`,
      });
      return;
    }
    setStatus(parsed);
    setStatusError(null);
  }, []);

  const reportStatusFailure = useCallback((error: unknown) => {
    const wireError = parseWireError(error);
    // Inline only: a read failure is not an install failure, and a toast here
    // would fire on every Settings visit with a broken backend.
    setStatusError(wireError);
    void captureError({
      level: "warn",
      source: FALLBACK_ENGINE_SECTION,
      message: `load-fallback-status-failed: ${wireError.raw}`,
    });
  }, []);

  const loadStatus = useCallback((): Promise<void> => {
    return invoke(STATUS_COMMAND).then(applyStatus, reportStatusFailure);
  }, [applyStatus, reportStatusFailure]);

  // Same shape as CacheManagerModal's size fetch: the read starts in the
  // effect body and only touches state from its callback, and a late reply is
  // dropped after unmount.
  useEffect(() => {
    let cancelled = false;
    invoke(STATUS_COMMAND)
      .then((payload: unknown) => {
        if (cancelled) return;
        applyStatus(payload);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        reportStatusFailure(error);
      });
    return () => {
      cancelled = true;
    };
  }, [applyStatus, reportStatusFailure]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<FallbackProgress>(MPV_FALLBACK_PROGRESS_EVENT, (event) => {
      // Only an install this section started may drive the UI: a stray event
      // must never flip an idle row into "downloading".
      if (!installingRef.current) return;
      const parsed = parseProgress(event.payload);
      if (parsed !== null) setProgress(parsed);
    })
      .then((stopListening) => {
        // `listen` resolves asynchronously; the effect may already be gone.
        if (disposed) {
          stopListening();
          return;
        }
        unlisten = stopListening;
      })
      .catch((error: unknown) => {
        void captureError({
          level: "warn",
          source: FALLBACK_ENGINE_SECTION,
          message: `listen-fallback-progress-failed: ${describeValue(error)}`,
        });
      });

    return () => {
      disposed = true;
      const stopListening = unlisten;
      if (stopListening === undefined) return;
      const reportUnlistenFailure = (error: unknown): void => {
        void captureError({
          level: "warn",
          source: FALLBACK_ENGINE_SECTION,
          message: `unlisten-fallback-progress-failed: ${describeValue(error)}`,
        });
      };
      try {
        // The declared UnlistenFn returns void, but a stubbed/overridden
        // implementation may return a promise. Typing the local as
        // `() => unknown` (a widening assignment, so no cast) plus
        // Promise.resolve lets both shapes be caught, so a teardown failure can
        // never surface as an unhandled rejection.
        const maybeAsyncUnlisten: () => unknown = stopListening;
        const result: unknown = maybeAsyncUnlisten();
        Promise.resolve(result).catch(reportUnlistenFailure);
      } catch (error: unknown) {
        reportUnlistenFailure(error);
      }
    };
  }, []);

  const runInstall = useCallback(async () => {
    if (installingRef.current) return;
    installingRef.current = true;
    setInstalling(true);
    setInstallError(null);
    setProgress(null);
    try {
      const payload: unknown = await invoke(INSTALL_COMMAND);
      // The command re-queries the settled status itself, so its return value
      // is authoritative — never derive "installed" from the event stream.
      const parsed = parseStatus(payload);
      if (parsed === null) {
        const malformed: WireError = {
          code: UNKNOWN_ERROR_CODE,
          raw: `unexpected ${INSTALL_COMMAND} payload`,
        };
        setInstallError(malformed);
        await captureError({
          level: "error",
          source: FALLBACK_ENGINE_SECTION,
          message: `install-fallback-failed: ${malformed.raw}`,
        });
        showErrorToast(t("settings.playback_components.error_toast"), {
          duration: ERROR_TOAST_MS,
        });
        return;
      }
      setStatus(parsed);
      setStatusError(null);
      showSuccessToast(t("settings.playback_components.success_toast"), {
        duration: SUCCESS_TOAST_MS,
      });
    } catch (error: unknown) {
      const wireError = parseWireError(error);
      // The installed facts (if any) stay on screen: a failed UPDATE must not
      // erase the fact that a working fallback engine is already on disk.
      setInstallError(wireError);
      await captureError({
        level: "error",
        source: FALLBACK_ENGINE_SECTION,
        message: `install-fallback-failed: ${wireError.raw}`,
      });
      showErrorToast(t("settings.playback_components.error_toast"), {
        duration: ERROR_TOAST_MS,
      });
    } finally {
      installingRef.current = false;
      setInstalling(false);
      setProgress(null);
    }
  }, [t]);

  const handleRetry = () => {
    if (installError !== null) {
      void runInstall();
      return;
    }
    void loadStatus();
  };

  const percent = progress?.percent ?? null;
  const downloaded = progress?.downloaded ?? null;
  const total = progress?.total ?? null;
  const determinate = percent !== null;
  const error = installError ?? statusError;
  const unavailableReason =
    status !== null && status.engine === "unavailable"
      ? status.unavailableReason
      : undefined;
  const actionLabel =
    status !== null && status.stage !== "notInstalled"
      ? t("settings.playback_components.button_reinstall")
      : t("settings.playback_components.button_download");

  return (
    <div
      data-testid="fallback-engine-section"
      className="flex flex-col gap-2 mt-6"
    >
      <h2 className="text-sm font-bold text-brand-text uppercase tracking-wider mb-2">
        {t("settings.playback_components.section_title")}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t("settings.playback_components.section_description")}
      </p>

      <div className="flex items-center justify-between py-4 pb-6">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
            <Cpu className="w-6 h-6 text-brand-text" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t("settings.playback_components.engine_name")}
            </p>

            <div
              data-testid="fallback-engine-status"
              role="status"
              aria-live="polite"
              className="flex flex-col gap-1"
            >
              {progress !== null ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t(STAGE_LABEL_KEYS[progress.stage])}
                </p>
              ) : null}

              {progress === null && status === null && error === null ? (
                <p
                  data-testid="fallback-engine-checking"
                  className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2"
                >
                  <LoaderCircle className="w-4 h-4 animate-spin" />
                  {t("settings.playback_components.stage_checking")}
                </p>
              ) : null}

              {status !== null ? (
                <>
                  {status.stage === "installed" ? (
                    <>
                      {status.version !== undefined ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t(
                            "settings.playback_components.status_installed",
                            { version: status.version },
                          )}
                        </p>
                      ) : null}
                      {status.size !== undefined ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t("settings.playback_components.status_size", {
                            size: formatBytes(status.size),
                          })}
                        </p>
                      ) : null}
                      {status.engine === "legacy" ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t("settings.playback_components.status_in_use")}
                        </p>
                      ) : null}
                      {status.engine === "libmpv" ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t(
                            "settings.playback_components.status_available_but_not_in_use",
                          )}
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  {status.stage === "notInstalled" ? (
                    <>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t(
                          "settings.playback_components.optional_explanation",
                        )}
                      </p>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t("settings.playback_components.pinned_version", {
                          version: status.pinnedVersion,
                        })}
                      </p>
                    </>
                  ) : null}

                  {status.stage === "invalid" ? (
                    <>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t("settings.playback_components.state_invalid")}
                      </p>
                      {status.reason !== undefined ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400 break-words">
                          {t("settings.playback_components.invalid_reason", {
                            reason: status.reason,
                          })}
                        </p>
                      ) : null}
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t("settings.playback_components.pinned_version", {
                          version: status.pinnedVersion,
                        })}
                      </p>
                    </>
                  ) : null}

                  {status.engine === "unavailable" ? (
                    <>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t("settings.playback_components.status_unavailable")}
                      </p>
                      {unavailableReason !== undefined ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {t(UNAVAILABLE_REASON_KEYS[unavailableReason])}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
            </div>

            {progress !== null ? (
              <div className="flex flex-col gap-1 mt-2">
                <div
                  data-testid="fallback-engine-progressbar"
                  role="progressbar"
                  aria-label={t("settings.playback_components.progress_label")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                  className="h-2 w-full max-w-[280px] sm:max-w-[400px] rounded-full bg-gray-200 dark:bg-[#2A2A2A] overflow-hidden"
                >
                  {determinate ? (
                    <div
                      className="h-full rounded-full bg-brand-primary transition-all"
                      style={{ width: `${String(percent)}%` }}
                    />
                  ) : (
                    <div className="h-full w-1/3 rounded-full bg-brand-primary animate-pulse" />
                  )}
                </div>
                {/* A null percent is "total size unknown": no number at all
                    rather than a fabricated one. */}
                {determinate ? (
                  <p
                    data-testid="fallback-engine-progress-text"
                    className="text-sm text-gray-500 dark:text-gray-400"
                  >
                    {`${String(percent)}%`}
                  </p>
                ) : null}
                {determinate && downloaded !== null && total !== null ? (
                  <p
                    data-testid="fallback-engine-progress-bytes"
                    className="text-sm text-gray-500 dark:text-gray-400"
                  >
                    {t("settings.playback_components.progress_transferred", {
                      downloaded: formatBytes(downloaded),
                      total: formatBytes(total),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="fallback-engine-action"
            onClick={() => {
              void runInstall();
            }}
            disabled={installing}
            className="px-5 py-2.5 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-brand-primary/40 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {installing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : null}
            {actionLabel}
          </button>
        </div>
      </div>

      {/* Persistent error: never auto-dismissed, never replaces installed
          facts (they stay in the row above), always carries the raw backend
          text so a bug report is actionable. */}
      {error !== null ? (
        <div
          data-testid="fallback-engine-error"
          role="alert"
          className="flex flex-col items-start gap-2 pb-6"
        >
          <p className="text-sm text-red-500">{t(errorMessageKey(error.code))}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 break-words">
            {t("settings.playback_components.error_detail", {
              detail: error.raw,
            })}
          </p>
          <button
            type="button"
            data-testid="fallback-engine-retry"
            onClick={handleRetry}
            disabled={installing}
            className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-brand-primary/40 disabled:opacity-50"
          >
            {t("settings.playback_components.button_retry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
