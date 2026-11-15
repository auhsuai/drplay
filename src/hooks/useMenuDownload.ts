import { useState, useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { getValidToken } from "../utils/apiClient";
import {
  getEffectiveDownloadPath,
  getCustomDownloadPath,
} from "../utils/downloadPath";
import { sanitizeFilename } from "../utils/sanitizeFilename";
import {
  classifyDownloadError,
  downloadErrorMessage,
  fetchMetadataBestEffort,
  toDownloadProgressState,
  type DownloadProgressState,
  type FileDownloadProgressEvent,
} from "../utils/fileDownload";
import { captureError } from "../utils/errorLog";
import type { Track } from "../types";
import type { TFunction } from "i18next";

// Streaming download, Rust-first: the bytes never pass through the
// WebView. The Rust command (`start_file_download`) streams the Drive file
// into `<dest>.part`, resumes it with HTTP Range, verifies size + MD5, and
// renames it into place; progress arrives over a Tauri Channel. The old
// frontend `fetch` + `arrayBuffer()` path buffered the ENTIRE file in RAM
// and is deliberately gone — do not reintroduce it for "simplicity".

export type FileDownloadResult = {
  path: string;
  size: number;
  resumed: boolean;
};

function newDownloadId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useMenuDownload(t: TFunction) {
  const [isDownloadingFile, setIsDownloadingFile] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [downloadFileName, setDownloadFileName] = useState("");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  // Which icon the DownloadToast shows for the message above: the toast
  // used to hardcode a green check for every message, so a failure
  // (e.g. no_space) looked like a success. Success sets "success", any
  // failure message sets "error"; a user cancel stays silent (null).
  const [downloadMessageKind, setDownloadMessageKind] = useState<
    "success" | "error"
  >("success");
  const [downloadTrack, setDownloadTrack] = useState<Track | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgressState | null>(null);
  const [downloadPaused, setDownloadPaused] = useState(false);

  // The id of the in-flight download: what pause/resume/cancel address.
  // Minted fresh per download (never reused), so a stale cancel for a
  // previous download can never touch the current one.
  const downloadIdRef = useRef<string | null>(null);
  // Sync busy-guard for executeDownload: state updates land only after
  // re-render, so two clicks in the same tick both read isDownloadingFile
  // as false and would start two downloads for one file.
  const isDownloadingRef = useRef(false);

  // Cancel the in-flight download when the component unmounts: the Rust
  // worker keeps the `.part` file, so a later download resumes it instead
  // of restarting.
  useEffect(() => {
    return () => {
      const id = downloadIdRef.current;
      if (id) {
        void invoke("cancel_file_download", { downloadId: id }).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (downloadMessage) {
      const timer = setTimeout(() => {
        setDownloadMessage(null);
      }, 5000);
      return () => {
        clearTimeout(timer);
      };
    }
  }, [downloadMessage]);

  const handleDownloadClick = (
    e: React.MouseEvent,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
  ) => {
    e.stopPropagation();
    if (!track) return;
    setDownloadTrack(track);
    setDownloadFileName(
      `${track.title} - ${track.artist || t("common.unknown")}`,
    );
    setDownloadProgress(null);
    setDownloadPaused(false);
    setShowDownloadDialog(true);
    setIsOpen(false);
  };

  const cancelDownload = async () => {
    const id = downloadIdRef.current;
    if (!id) return;
    try {
      await invoke("cancel_file_download", { downloadId: id });
    } catch (err: unknown) {
      void captureError({
        level: "warn",
        source: "useMenuDownload",
        message: `Cancel download failed: ${String(err)}`,
      });
    }
  };

  const pauseDownload = async () => {
    const id = downloadIdRef.current;
    if (!id) return;
    try {
      await invoke("pause_file_download", { downloadId: id });
      setDownloadPaused(true);
    } catch (err: unknown) {
      void captureError({
        level: "warn",
        source: "useMenuDownload",
        message: `Pause download failed: ${String(err)}`,
      });
    }
  };

  const resumeDownload = async () => {
    const id = downloadIdRef.current;
    if (!id) return;
    try {
      await invoke("resume_file_download", { downloadId: id });
      setDownloadPaused(false);
    } catch (err: unknown) {
      void captureError({
        level: "warn",
        source: "useMenuDownload",
        message: `Resume download failed: ${String(err)}`,
      });
    }
  };

  const executeDownload = async () => {
    // Race guard (2nd layer behind the disabled Confirm button): a
    // double-click fires twice in the same tick, before React re-renders —
    // the isDownloadingFile state read below is still stale false for the
    // second click. The ref check-and-set below closes that window (same
    // pattern as useFolderPicker's isLoadingRef).
    if (isDownloadingRef.current || isDownloadingFile || !downloadTrack) return;
    isDownloadingRef.current = true;
    setIsDownloadingFile(true);
    // The dialog STAYS open while the download runs: it is the progress
    // surface (percent, speed, Pause/Cancel). It closes in `finally`,
    // once the download settles and the toast takes over.
    setDownloadProgress(null);
    setDownloadPaused(false);

    const track = downloadTrack;
    const downloadId = newDownloadId();
    downloadIdRef.current = downloadId;

    try {
      const freshToken = await getValidToken(false);
      if (!freshToken) throw new Error("unauthorized: no valid token");

      const dir = await getEffectiveDownloadPath();
      if (getCustomDownloadPath()) {
        try {
          // Extend the fs scope so the Rust command may write outside the
          // base $DOWNLOAD scope (runtime scope extension, tauri_plugin_fs::FsExt).
          // If this fails the start command itself rejects with a scope
          // error — do not block the main flow here, let it surface there.
          await invoke("register_download_path", { path: dir });
        } catch (scopeErr: unknown) {
          void captureError({
            level: "warn",
            source: "useMenuDownload",
            message: `Failed to extend fs scope for custom download dir: ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`,
          });
        }
      }

      // Metadata for the Rust gates: the size feeds the pre-flight
      // free-space check and the progress total, the MD5 feeds the
      // verification gate. Best-effort: a transient metadata failure does
      // not block the download (the command falls back to Content-Length),
      // but a 404/410 means the file is gone and the download is refused
      // here, before any byte moves.
      const { metadata, fileGone } = await fetchMetadataBestEffort(track.id);
      if (fileGone)
        throw new Error("file_missing: the file is no longer on Drive");
      const expectedSize = metadata.size ?? track.size;

      // Pre-flight free-space check: refuse a download that cannot fit
      // instead of failing halfway through a multi-GB transfer. The Rust
      // command re-checks the same value itself, so a race between this
      // check and the start can only make the warning stale, never the
      // download wrong.
      if (expectedSize !== undefined) {
        const free = await invoke<number | null>("file_download_free_space", {
          dir,
        }).catch(() => null);
        if (free !== null && free < expectedSize) {
          throw new Error(
            "insufficient_space: not enough free space on the destination drive",
          );
        }
      }

      const base = downloadFileName.trim() || "audio";
      const ext = track.originalName?.includes(".")
        ? track.originalName.slice(track.originalName.lastIndexOf("."))
        : ".mp3";
      const finalFileName = sanitizeFilename(
        `${base}${ext}`,
        t("menu.untitled"),
      );
      // join() uses the platform-specific separator (Tauri v2 path API) so a
      // POSIX build no longer writes a literal backslash into the file name.
      const savePath = await join(dir, finalFileName);

      // Progress arrives over a Tauri Channel: one invoke, many ordered
      // events, no polling. The channel is created per download so a stale
      // event from a previous download can never update this one.
      const channel = new Channel<FileDownloadProgressEvent>((event) => {
        const state = toDownloadProgressState(event);
        setDownloadProgress(state);
        setDownloadPaused(state.paused);
      });

      const result = await invoke<FileDownloadResult>("start_file_download", {
        request: {
          downloadId,
          fileId: track.id,
          destPath: savePath,
          token: freshToken,
          expectedSize: expectedSize ?? null,
          md5: metadata.md5Checksum ?? null,
        },
        onProgress: channel,
      });

      setDownloadMessage(`${t("menu.saved_at")} ${result.path}`);
      setDownloadMessageKind("success");
    } catch (err: unknown) {
      const kind = classifyDownloadError(err);
      void captureError({
        level: "error",
        source: "useMenuDownload",
        message: `Download failed (${kind}): ${String(err)}`,
      });
      // A user-initiated cancel is silent by design; every other failure
      // gets a specific message instead of the old single generic toast.
      const message = downloadErrorMessage(kind, t);
      if (message !== null) {
        setDownloadMessage(message);
        setDownloadMessageKind("error");
      }
    } finally {
      downloadIdRef.current = null;
      isDownloadingRef.current = false;
      setIsDownloadingFile(false);
      setDownloadProgress(null);
      setDownloadPaused(false);
      setShowDownloadDialog(false);
    }
  };

  return {
    isDownloadingFile,
    showDownloadDialog,
    setShowDownloadDialog,
    downloadFileName,
    setDownloadFileName,
    downloadMessage,
    setDownloadMessage,
    downloadMessageKind,
    downloadProgress,
    downloadPaused,
    handleDownloadClick,
    executeDownload,
    cancelDownload,
    pauseDownload,
    resumeDownload,
  };
}
