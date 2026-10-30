import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Cpu, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

/**
 * Rust event: the settled status changed on disk (a successful install or a
 * removal performed anywhere — the cache dialog can remove this engine, which
 * would otherwise leave this row offering "Reinstall" for a missing file).
 *
 * Payload is the same camelCase `FallbackStatusDto` the commands return. A
 * payload that does not parse falls back to re-reading the status, so a wire
 * drift degrades to "one extra read" rather than a stale row.
 */
export const MPV_FALLBACK_CHANGED_EVENT = "mpv-fallback-changed";

/** Settled install state. "installed" is a claim about DISK, not about use. */
export type FallbackStage = "notInstalled" | "installed" | "invalid";
/** Which engine this process will actually use. Only "legacy" means in use. */
export type FallbackEngineKind = "libmpv" | "legacy" | "unavailable";
export type FallbackUnavailableReason =
  "libmpvFailedNoSidecar" | "sidecarRequestedButMissing";
export type FallbackProgressStage =
  "downloading" | "verifying" | "extracting" | "publishing";

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

/**
 * The settled status as it arrives on the wire. Structurally identical to
 * [`FallbackStatus`]; a named alias keeps the `listen<T>` call site honest about
 * what the backend actually sends (the full DTO, not a progress frame).
 */
type FallbackStatusDtoWire = FallbackStatus;

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

type ProgressStageKey =
  `settings.playback_components.stage_${FallbackProgressStage}`;
type UnavailableKey =
  | "settings.playback_components.unavailable_libmpv_failed_no_sidecar"
  | "settings.playback_components.unavailable_sidecar_requested_but_missing";
type ErrorKey =
  `settings.playback_components.error_${FallbackErrorCode | "generic"}`;

const GENERIC_ERROR_KEY: ErrorKey =
  "settings.playback_components.error_generic";

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
  // Synchronous re-entrancy guard: `installing` only flips after React
  // flushes, so two clicks in one tick would otherwise reach
  // Rust twice (the second rejection would be "already_in_progress").
  const installingRef = useRef(false);
  // Guards the initial status read: a reply that lands after unmount must not
  // touch state (React would warn and the section is gone anyway).
  const mountedRef = useRef(true);
  // Monotonic generation of the settled state. Any authoritative transition
  // (an install result, an install/remove announcement from Rust) bumps it, and
  // a status READ may only apply the generation it started under.
  //
  // Why: the initial read is fired on mount and can still be in flight when an
  // install finishes. Its reply describes the PRE-install disk, so applying it
  // late would replace "installed" with "Not installed · Download" — the row
  // would flip back seconds after a successful download.
  const statusGenerationRef = useRef(0);
  // True once a settled status has been applied for the current install cycle.
  // From then until the next install starts, a progress event must never make
  // the row look busy again (`progress` outranks `status` when rendering, so a
  // late "downloading" frame would hide a perfectly settled install).
  const settledRef = useRef(false);

  /**
   * Applies a settled status as the current truth: bumps the generation, so
   * every status read already in flight is invalidated.
   */
  const applySettledStatus = useCallback((parsed: FallbackStatus) => {
    if (!mountedRef.current) return;
    statusGenerationRef.current += 1;
    settledRef.current = true;
    setStatus(parsed);
    setStatusError(null);
  }, []);

  const applyStatus = useCallback(
    (payload: unknown, generation: number) => {
      if (!mountedRef.current) return;
      // Stale: a newer settled state landed while this read was in flight.
      if (generation !== statusGenerationRef.current) return;
      // An install owns the row while it runs; its command result is the only
      // authority. Letting a read land here would render the pre-install state
      // underneath the progress line.
      if (installingRef.current) return;
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
      applySettledStatus(parsed);
    },
    [applySettledStatus],
  );

  const reportStatusFailure = useCallback(
    (error: unknown, generation: number) => {
      if (!mountedRef.current) return;
      // A failure from a superseded read must not surface over newer state.
      if (generation !== statusGenerationRef.current) return;
      if (installingRef.current) return;
      const wireError = parseWireError(error);
      // Inline only: a read failure is not an install failure, and a toast here
      // would fire on every Settings visit with a broken backend.
      setStatusError(wireError);
      void captureError({
        level: "warn",
        source: FALLBACK_ENGINE_SECTION,
        message: `load-fallback-status-failed: ${wireError.raw}`,
      });
    },
    [],
  );

  const loadStatus = useCallback((): Promise<void> => {
    // Capture BEFORE the await: this is the generation this reply describes.
    const generation = statusGenerationRef.current;
    return invoke(STATUS_COMMAND).then(
      (payload: unknown) => {
        applyStatus(payload, generation);
      },
      (error: unknown) => {
        reportStatusFailure(error, generation);
      },
    );
  }, [applyStatus, reportStatusFailure]);

  // Same shape as CacheManagerModal's size fetch: the read starts in the
  // effect body and only touches state from its callback, and a late reply is
  // dropped after unmount.
  useEffect(() => {
    mountedRef.current = true;
    void loadStatus();
    return () => {
      mountedRef.current = false;
    };
  }, [loadStatus]);

  // Install progress. Two guards, and both matter:
  //  * `installingRef` — only an install this section started may drive the row.
  //  * `settledRef`    — once the status is settled, a late frame (the download
  //    stream can deliver one after the command resolved) must not resurrect
  //    "Downloading…" over the installed facts. It is only cleared when the
  //    NEXT install starts.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<FallbackProgress>(MPV_FALLBACK_PROGRESS_EVENT, (event) => {
      if (!installingRef.current) return;
      if (settledRef.current) return;
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

  // Settled change announcements from Rust (install or removal anywhere in the
  // app — the cache dialog removes this engine too). Same teardown discipline
  // as the progress listener above.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<FallbackStatusDtoWire>(MPV_FALLBACK_CHANGED_EVENT, (event) => {
      if (!mountedRef.current) return;
      // An install in flight owns the row: its own command result is newer than
      // whatever announcement arrives while it runs.
      if (installingRef.current) return;
      const parsed = parseStatus(event.payload);
      if (parsed === null) {
        // Unparseable payload: re-read rather than guess. Cheap, and a drift in
        // the wire shape must never leave a stale row.
        void loadStatus();
        return;
      }
      applySettledStatus(parsed);
    })
      .then((stopListening) => {
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
          message: `listen-fallback-changed-failed: ${describeValue(error)}`,
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
          message: `unlisten-fallback-changed-failed: ${describeValue(error)}`,
        });
      };
      try {
        const maybeAsyncUnlisten: () => unknown = stopListening;
        const result: unknown = maybeAsyncUnlisten();
        Promise.resolve(result).catch(reportUnlistenFailure);
      } catch (error: unknown) {
        reportUnlistenFailure(error);
      }
    };
  }, [applySettledStatus, loadStatus]);

  const runInstall = useCallback(async () => {
    if (installingRef.current) return;
    installingRef.current = true;
    // A new install cycle: progress events are welcome again until this one
    // settles.
    settledRef.current = false;
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
      // Settle BEFORE the toast: `applySettledStatus` marks the generation, so
      // any late progress frame or in-flight status read is dropped from here on.
      applySettledStatus(parsed);
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
      // Order matters: clear the in-flight refs first, then the progress state,
      // so no guard window exists in which a queued frame is both accepted and
      // rendered. The ref is only released here, after the status settled (or
      // the install failed), which is what makes the `settledRef` gate hold.
      installingRef.current = false;
      setInstalling(false);
      setProgress(null);
    }
  }, [applySettledStatus, t]);

  const percent = progress?.percent ?? null;
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

              {/* While an install is in flight the progress line + bar below
                  are the only status: showing the resting "Not installed ·
                  optional · …" line underneath it reads as two contradictory
                  states at once. */}
              {progress === null && status !== null ? (
                <>
                  {status.stage === "installed" ? (
                    <>
                      <p
                        data-testid="fallback-engine-installed"
                        className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1.5"
                      >
                        <CheckCircle2 className="w-4 h-4 text-brand-primary shrink-0" />
                        {t("settings.playback_components.status_installed")}
                      </p>
                    </>
                  ) : null}

                  {status.stage === "notInstalled" ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t("settings.playback_components.status_not_installed")}
                    </p>
                  ) : null}

                  {status.stage === "invalid" ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 break-words">
                      {t("settings.playback_components.state_invalid", {
                        reason: status.reason ?? "",
                      })}
                    </p>
                  ) : null}

                  {status.engine === "unavailable" ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {unavailableReason !== undefined
                        ? t(UNAVAILABLE_REASON_KEYS[unavailableReason])
                        : t("settings.playback_components.status_unavailable")}
                    </p>
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
                    <div className="h-full w-1/3 rounded-full bg-brand-primary fallback-progress-indeterminate" />
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="fallback-engine-action"
            onClick={() => {
              // A failed status READ is not an install failure: the button
              // re-reads instead of blindly starting a download. Once a real
              // status is known it installs (or reinstalls).
              if (statusError !== null && status === null) {
                setStatusError(null);
                void loadStatus();
                return;
              }
              void runInstall();
            }}
            disabled={installing}
            className="px-5 py-2.5 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-brand-primary/40 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {installing ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : null}
            {actionLabel}
          </button>
        </div>
      </div>

      {/* Persistent error: never auto-dismissed, never replaces installed
          facts (they stay in the row above). The action button in the row is
          the retry affordance, so there is no second button here. */}
      {error !== null ? (
        <div data-testid="fallback-engine-error" role="alert" className="pb-6">
          <p className="text-sm text-red-500">
            {t(errorMessageKey(error.code))}
          </p>
        </div>
      ) : null}
    </div>
  );
}
