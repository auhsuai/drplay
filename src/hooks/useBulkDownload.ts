import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { getValidToken } from "../utils/apiClient";
import {
  getEffectiveDownloadPath,
  getCustomDownloadPath,
} from "../utils/downloadPath";
import {
  classifyDownloadError,
  downloadErrorMessage,
  toDownloadProgressState,
  type DownloadErrorKind,
  type FileDownloadProgressEvent,
} from "../utils/fileDownload";
import {
  FOLDER_DOWNLOAD_CONCURRENCY,
  computeFolderProgress,
  expandSelectionToPlan,
  isFolderDownloadFatalKind,
  type BulkDownloadPlan,
  type FolderDownloadFile,
  type FolderProgress,
  type PlannedBulkFile,
} from "../utils/folderDownload";
import { createSemaphore } from "../utils/asyncLimit";
import { captureError } from "../utils/errorLog";
import type { DriveItem } from "../types";
import type { TFunction } from "i18next";

// Selection-driven bulk download: "download exactly what is selected".
// There is NO download UI of its own — the entry point is the existing
// selection flow (⋯ → Select multiple, tick rows, Download in the
// SelectionToolbar, or ⋯ → Download on a bulk-selected row), and feedback
// is the existing DownloadToast (one line, auto-dismissed after 5 s).
// Each file reuses the Step 1 Rust streamer (`start_file_download`) with
// its own Channel; no second download path exists. Concurrency is ~4
// files via createSemaphore; a single file's failure is recorded and the
// queue keeps going — only a system failure (unrefreshable sign-in,
// unwritable destination, full disk) aborts the whole job. Re-running the
// same selection retries only what is missing: a file already complete on
// disk is skipped by the Rust command (size gate) instead of
// re-downloading, and a kept `.part` file resumes with HTTP Range.
//
// The DownloadPanel (MainContent) is the per-file view on top of this
// hook — it previews the scanned plan before the job starts (so the user
// sees the file count and can untick files), then renders `bulkFileStates`
// live while the job runs. The panel adds no download path of its own:
// preview reuses `expandSelectionToPlan`, starting reuses the same
// `beginJob` runner as the one-shot `handleBulkDownload`, and cancelling
// one file reuses the Rust `cancel_file_download` command.

export type BulkFileStatus =
  "queued" | "downloading" | "verifying" | "done" | "failed" | "cancelled";

export interface BulkFileState {
  planned: PlannedBulkFile;
  status: BulkFileStatus;
  downloaded: number;
  total?: number | undefined;
  percent?: number | undefined;
  speedBytesPerSec?: number | undefined;
  /** Localised reason, only for `failed`. */
  errorMessage?: string | undefined;
}

export interface BulkFailedItem {
  /** Display path, e.g. `Album/Sub/song (1).mp3` or `loose.pdf`. */
  name: string;
  reason: string;
}

export interface BulkDownloadSummary {
  completed: number;
  total: number;
  failed: BulkFailedItem[];
  skipped: number;
  cancelled: boolean;
  /** Set when a system failure stopped the whole job. */
  fatalKind?: DownloadErrorKind | undefined;
}

/** Which icon the DownloadToast shows for `bulkMessage`: progress and
 * cancelled lines are neutral ("info"), a finished job with failures or
 * a fatal kind (incl. no_space) is an error, a clean finish is success. */
export type BulkMessageKind = "success" | "error" | "info";

/** Toast updates at most once a second: the Rust progress throttle (200 ms
 * / 1% per file, ×4 files) would otherwise re-render MainContent ~20×/s. */
const BULK_TOAST_THROTTLE_MS = 1000;

function newJobId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `bd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useBulkDownload(t: TFunction) {
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkMessageKind, setBulkMessageKind] =
    useState<BulkMessageKind>("info");
  const [bulkProgress, setBulkProgress] = useState<FolderProgress>({
    completed: 0,
    total: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    percent: undefined,
  });
  const [summary, setSummary] = useState<BulkDownloadSummary | null>(null);
  /** Live per-file states for the DownloadPanel (mirrors `fileStatesRef`,
   * which stays the source of truth for the job logic itself). */
  const [bulkFileStates, setBulkFileStates] = useState<BulkFileState[]>([]);
  /** Scanned-but-not-started plan for the DownloadPanel preview. */
  const [previewPlan, setPreviewPlan] = useState<BulkDownloadPlan | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const activeRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const cancelledIndicesRef = useRef<Set<number>>(new Set());
  const runningIdsRef = useRef<Map<number, string>>(new Map());
  const fatalKindRef = useRef<DownloadErrorKind | null>(null);
  const planRef = useRef<BulkDownloadPlan | null>(null);
  const destDirRef = useRef("");
  const fileStatesRef = useRef<BulkFileState[]>([]);
  const lastToastAtRef = useRef(0);

  // The toast auto-dismisses like the single-file one; a fresh message
  // (progress tick or final summary) restarts the timer.
  useEffect(() => {
    if (!bulkMessage) return;
    const timer = setTimeout(() => {
      setBulkMessage(null);
    }, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [bulkMessage]);

  // Deliberately NO unmount cancel (unlike the single-file hook): this hook
  // lives in MainContent, and navigating away must not kill a multi-GB
  // job — the Rust workers keep their `.part` files and finish on their
  // own. Progress updates after unmount are harmless no-ops.

  const updateFileState = (
    index: number,
    patch: Partial<BulkFileState>,
  ): void => {
    fileStatesRef.current = fileStatesRef.current.map((s, i) =>
      i === index ? { ...s, ...patch } : s,
    );
    setBulkFileStates(fileStatesRef.current);
  };

  const updateProgress = (force: boolean): void => {
    const progress = computeFolderProgress(
      fileStatesRef.current.map((s) => ({
        downloaded: s.downloaded,
        total: s.total,
        done: s.status === "done",
      })),
    );
    setBulkProgress(progress);
    const now = Date.now();
    if (force || now - lastToastAtRef.current >= BULK_TOAST_THROTTLE_MS) {
      lastToastAtRef.current = now;
      setBulkMessageKind("info");
      setBulkMessage(
        t("menu.bulk_download_progress", {
          completed: progress.completed,
          total: progress.total,
        }),
      );
    }
  };

  const setFatal = (kind: DownloadErrorKind | null): void => {
    fatalKindRef.current = kind;
  };

  const cancelRunning = async (): Promise<void> => {
    const ids = [...runningIdsRef.current.values()];
    await Promise.all(
      ids.map((id) =>
        invoke("cancel_file_download", { downloadId: id }).catch(() => {}),
      ),
    );
  };

  const downloadOne = async (
    planned: PlannedBulkFile,
    index: number,
    token: string,
    dir: string,
  ): Promise<void> => {
    if (cancelledIndicesRef.current.has(index)) {
      updateFileState(index, { status: "cancelled" });
      return;
    }
    const file: FolderDownloadFile = planned.file;
    const downloadId = `${jobIdRef.current ?? "bd"}-${String(index)}`;
    runningIdsRef.current.set(index, downloadId);
    try {
      let destPath = dir;
      for (const segment of [
        ...planned.rootSegments,
        ...file.destRelativePath,
      ]) {
        destPath = await join(destPath, segment);
      }
      const channel = new Channel<FileDownloadProgressEvent>((event) => {
        const state = toDownloadProgressState(event);
        updateFileState(index, {
          status: state.stage === "verifying" ? "verifying" : "downloading",
          downloaded: state.downloaded,
          total: state.total,
          percent: state.percent,
          speedBytesPerSec: state.speedBytesPerSec,
        });
        updateProgress(false);
      });
      updateFileState(index, { status: "downloading" });
      await invoke("start_file_download", {
        request: {
          downloadId,
          fileId: file.id,
          destPath,
          token,
          expectedSize: file.size ?? null,
          md5: file.md5Checksum ?? null,
        },
        onProgress: channel,
      });
      updateFileState(index, {
        status: "done",
        downloaded: file.size ?? 0,
        total: file.size,
        percent: 100,
        speedBytesPerSec: undefined,
      });
      updateProgress(true);
    } catch (err: unknown) {
      const kind = classifyDownloadError(err);
      if (kind === "cancelled") {
        updateFileState(index, { status: "cancelled" });
        updateProgress(true);
        return;
      }
      if (isFolderDownloadFatalKind(kind)) {
        // System failure: stop the whole job — abort the queue and cancel
        // every file already running, then surface the kind once.
        setFatal(kind);
        abortRef.current?.abort();
        await cancelRunning();
        updateFileState(index, {
          status: "failed",
          errorMessage: downloadErrorMessage(kind, t) ?? undefined,
        });
        throw err;
      }
      void captureError({
        level: "error",
        source: "useBulkDownload",
        message: `Bulk file failed (${kind}): ${[...planned.rootSegments, ...file.destRelativePath].join("/")}`,
      });
      updateFileState(index, {
        status: "failed",
        errorMessage: downloadErrorMessage(kind, t) ?? undefined,
      });
      updateProgress(true);
    } finally {
      runningIdsRef.current.delete(index);
    }
  };

  const runFiles = async (
    plan: BulkDownloadPlan,
    token: string,
    dir: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const semaphore = createSemaphore(FOLDER_DOWNLOAD_CONCURRENCY);
    await Promise.allSettled(
      plan.files.map((planned, index) =>
        semaphore.run(() => downloadOne(planned, index, token, dir), signal),
      ),
    );
  };

  const finishJob = (wasAborted: boolean, dir: string): void => {
    const cancelled = wasAborted && fatalKindRef.current === null;
    const states = fileStatesRef.current;
    const failed: BulkFailedItem[] = states
      .filter((s) => s.status === "failed")
      .map((s) => ({
        name: [
          ...s.planned.rootSegments,
          ...s.planned.file.destRelativePath,
        ].join("/"),
        reason: s.errorMessage ?? t("menu.download_failed"),
      }));
    // Files gone from Drive never reached the queue: they count as failed
    // in the summary so the toast never claims a clean run.
    const plan = planRef.current;
    if (plan) {
      for (const item of plan.unavailable) {
        failed.push({
          name: item.name,
          reason:
            downloadErrorMessage(item.kind, t) ?? t("menu.download_failed"),
        });
      }
    }
    const completed = states.filter((s) => s.status === "done").length;
    const skipped = plan?.skipped.length ?? 0;
    // `total` counts every file the job was asked for: queued files plus
    // the unavailable ones that never queued.
    const total = states.length + (plan?.unavailable.length ?? 0);
    const summaryValue: BulkDownloadSummary = {
      completed,
      total,
      failed,
      skipped,
      cancelled,
      fatalKind: fatalKindRef.current ?? undefined,
    };
    setSummary(summaryValue);
    setIsBulkDownloading(false);
    activeRef.current = false;
    if (cancelled) {
      setBulkMessageKind("info");
      setBulkMessage(t("menu.bulk_download_cancelled"));
    } else if (fatalKindRef.current) {
      setBulkMessageKind("error");
      setBulkMessage(
        downloadErrorMessage(fatalKindRef.current, t) ??
          t("menu.download_failed"),
      );
    } else if (failed.length > 0) {
      setBulkMessageKind("error");
      setBulkMessage(
        t("menu.bulk_download_done_partial", {
          completed,
          total: summaryValue.total,
          failed: failed.length,
          skipped,
        }),
      );
    } else if (skipped > 0) {
      // Everything downloadable finished; the skipped items (native Docs,
      // no permission) were reported, not failed — still a success toast.
      setBulkMessageKind("success");
      setBulkMessage(
        t("menu.bulk_download_done_partial", {
          completed,
          total: summaryValue.total,
          failed: failed.length,
          skipped,
        }),
      );
    } else {
      setBulkMessageKind("success");
      setBulkMessage(
        t("menu.bulk_download_done", {
          completed,
          total: summaryValue.total,
          dir,
        }),
      );
    }
  };

  /**
   * The middle of a job, shared by the one-shot `handleBulkDownload` and
   * the panel's `startPlannedDownload`: pre-flight free-space check,
   * root-folder creation, then the parallel queue. Returns
   * "preflight_failed" when the destination cannot fit the plan (the
   * caller then finishes the job so the fatal toast/summary are set once);
   * anything else thrown is a job-level failure for the caller's catch.
   */
  const executePlan = async (
    plan: BulkDownloadPlan,
    token: string,
    dir: string,
    signal: AbortSignal,
  ): Promise<"started" | "preflight_failed"> => {
    // Pre-flight: refuse a job that cannot fit instead of failing
    // halfway through a multi-GB transfer.
    if (plan.totalBytes > 0) {
      const free = await invoke<number | null>("file_download_free_space", {
        dir,
      }).catch(() => null);
      if (free !== null && free < plan.totalBytes) {
        setFatal("no_space");
        return "preflight_failed";
      }
    }
    // Create the folder roots up front (also when every file inside was
    // skipped, so the user still sees the empty folder).
    for (const root of plan.roots) {
      const rootDest = await join(dir, root);
      await invoke("ensure_download_directory", { path: rootDest });
    }
    fileStatesRef.current = plan.files.map((planned) => ({
      planned,
      status: "queued" as const,
      downloaded: 0,
      total: planned.file.size,
    }));
    setBulkFileStates(fileStatesRef.current);
    updateProgress(true);
    await runFiles(plan, token, dir, signal);
    return "started";
  };

  /**
   * The whole job runner: guard + reset + token/dir, then the plan from
   * `resolvePlan`, then `executePlan`, then the finish/catch bookkeeping.
   * `handleBulkDownload` resolves the plan by scanning the selection;
   * `startPlannedDownload` resolves it from the panel's preview.
   */
  const beginJob = async (
    resolvePlan: (
      token: string,
      signal: AbortSignal,
    ) => Promise<BulkDownloadPlan>,
  ): Promise<void> => {
    if (activeRef.current) return;
    activeRef.current = true;
    setIsBulkDownloading(true);
    setSummary(null);
    setFatal(null);
    fileStatesRef.current = [];
    setBulkFileStates([]);
    lastToastAtRef.current = 0;
    const controller = new AbortController();
    abortRef.current = controller;
    jobIdRef.current = newJobId();
    cancelledIndicesRef.current = new Set();
    runningIdsRef.current = new Map();
    try {
      const freshToken = await getValidToken(false);
      if (!freshToken) throw new Error("unauthorized: no valid token");
      const dir = await getEffectiveDownloadPath();
      destDirRef.current = dir;
      if (getCustomDownloadPath()) {
        try {
          await invoke("register_download_path", { path: dir });
        } catch (scopeErr: unknown) {
          void captureError({
            level: "warn",
            source: "useBulkDownload",
            message: `Failed to extend fs scope for custom download dir: ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`,
          });
        }
      }
      const plan = await resolvePlan(freshToken, controller.signal);
      planRef.current = plan;
      if (plan.files.length === 0 && plan.unavailable.length === 0) {
        // Nothing downloadable (e.g. only native Docs selected): say so
        // instead of flashing a 0-file "done" toast.
        setBulkMessageKind("info");
        setBulkMessage(t("menu.bulk_download_empty"));
        setIsBulkDownloading(false);
        activeRef.current = false;
        return;
      }
      const outcome = await executePlan(
        plan,
        freshToken,
        dir,
        controller.signal,
      );
      if (outcome === "preflight_failed") {
        finishJob(false, dir);
        return;
      }
    } catch (err: unknown) {
      const kind = classifyDownloadError(err);
      if (kind === "cancelled" || controller.signal.aborted) {
        finishJob(true, destDirRef.current);
        return;
      }
      if (isFolderDownloadFatalKind(kind)) {
        setFatal(kind);
      } else {
        void captureError({
          level: "error",
          source: "useBulkDownload",
          message: `Bulk download failed (${kind}): ${String(err)}`,
        });
        setFatal("unknown");
      }
    } finally {
      runningIdsRef.current.clear();
    }
    finishJob(controller.signal.aborted, destDirRef.current);
  };

  const handleBulkDownload = async (items: DriveItem[]): Promise<void> => {
    if (items.length === 0) return;
    await beginJob(async (token, signal) => {
      // Expand the selection first: a folder's scan tells the user the
      // job's size before any byte moves, and a scan failure fails the
      // job instead of downloading half a folder.
      return expandSelectionToPlan(items, token, { signal });
    });
  };

  /**
   * Scan the selection WITHOUT starting a job, for the DownloadPanel
   * preview: the file count, the tree, and the ticked subset all come
   * from this plan. A fresh preview aborts a previous scan in flight.
   */
  const previewBulkSelection = async (
    items: DriveItem[],
  ): Promise<BulkDownloadPlan | null> => {
    if (items.length === 0) return null;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setIsPreviewing(true);
    setPreviewError(null);
    try {
      const freshToken = await getValidToken(false);
      if (!freshToken) throw new Error("unauthorized: no valid token");
      const plan = await expandSelectionToPlan(items, freshToken, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return null;
      setPreviewPlan(plan);
      return plan;
    } catch (err: unknown) {
      if (controller.signal.aborted) return null;
      const kind = classifyDownloadError(err);
      void captureError({
        level: "error",
        source: "useBulkDownload",
        message: `Bulk download preview failed (${kind}): ${String(err)}`,
      });
      setPreviewError(
        downloadErrorMessage(kind, t) ?? t("menu.download_failed"),
      );
      setPreviewPlan(null);
      return null;
    } finally {
      if (previewAbortRef.current === controller) setIsPreviewing(false);
    }
  };

  const clearPreview = (): void => {
    previewAbortRef.current?.abort();
    setPreviewPlan(null);
    setPreviewError(null);
  };

  /**
   * Start a job from an already-scanned plan (the panel's ticked subset):
   * the same `beginJob` runner as `handleBulkDownload`, so the pre-flight
   * check, the resume/skip behaviour and the finish/summary are identical.
   * The subset keeps the preview's roots/skipped/unavailable lists, so a
   * folder whose files were all unticked still gets its (empty) root.
   */
  const startPlannedDownload = async (
    plan: BulkDownloadPlan,
  ): Promise<void> => {
    await beginJob(() => Promise.resolve(plan));
  };

  const cancelBulkDownload = async (): Promise<void> => {
    if (!activeRef.current) return;
    abortRef.current?.abort();
    await cancelRunning();
  };

  /**
   * Cancel ONE file; the rest of the job keeps going. A running file is
   * cancelled through the Rust command (its `downloadOne` catch marks it
   * "cancelled"); a still-queued file is recorded in
   * `cancelledIndicesRef`, so `downloadOne` skips it when its turn comes
   * — and is marked cancelled in the panel immediately instead of sitting
   * at "queued" until then.
   */
  const cancelBulkFile = async (index: number): Promise<void> => {
    if (!activeRef.current) return;
    cancelledIndicesRef.current.add(index);
    const id = runningIdsRef.current.get(index);
    if (id) {
      await invoke("cancel_file_download", { downloadId: id }).catch(() => {});
    }
    updateFileState(index, { status: "cancelled" });
    updateProgress(false);
  };

  return {
    isBulkDownloading,
    bulkMessage,
    setBulkMessage,
    bulkMessageKind,
    bulkProgress,
    summary,
    bulkFileStates,
    previewPlan,
    isPreviewing,
    previewError,
    previewBulkSelection,
    clearPreview,
    startPlannedDownload,
    handleBulkDownload,
    cancelBulkDownload,
    cancelBulkFile,
  };
}
