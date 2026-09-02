import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { getValidToken } from "../utils/apiClient";
import {
  getEffectiveDownloadPath,
  getCustomDownloadPath,
} from "../utils/downloadPath";
import { mergeWithTimeoutSignal } from "../utils/driveApi";
import { authHeaders, DRIVE_FILES_URL } from "../utils/driveFiles";
import { isUploading } from "../utils/uploadManager";
import { showErrorToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";
import { isAbortError } from "./player/utils";
import type { Track } from "../types";
import type { TFunction } from "i18next";

// The download buffers the ENTIRE file into RAM via arrayBuffer(), so an
// unresponsive server would hold the bytes (and memory) forever. 5 minutes is
// generous for legit multi-hundred-MB audio files yet still bounds the
// pathological case. AbortSignal.timeout rejects with a DOMException named
// 'TimeoutError' (MDN AbortSignal.timeout, Baseline 2024). Same pattern as
// fetchWithAuth / useDrive.ts.
const DOWNLOAD_TIMEOUT_MS = 300_000;

// Windows forbids these characters in file names; also guard against DOS
// device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) and trailing dots/spaces.
// Copied verbatim from the removed GlobalContextMenu.tsx (the last known-good
// download implementation) so the written name matches what worked before.
// \p{Cc} matches Unicode control characters (incl. C0 \x00-\x1F plus the C1
// range \x7F-\x9F) — slightly wider than the old literal class, but avoids
// eslint no-control-regex (control chars cannot be written in a regex literal)
// and is strictly safer for Windows file names.
const sanitizeFilename = (
  name: string,
  fallbackName: string = "untitled",
): string => {
  let s = name.replace(/[/\\<>:"|?*\p{Cc}]/gu, "_");
  s = s.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i, "_$1$2");
  s = s.replace(/[\s.]+$/g, "");
  s = s.slice(0, 255);
  return s || fallbackName;
};

export function useMenuDownload(t: TFunction) {
  const [isDownloadingFile, setIsDownloadingFile] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [downloadFileName, setDownloadFileName] = useState("");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadTrack, setDownloadTrack] = useState<Track | null>(null);

  // Abort the in-flight download when the component unmounts (or a newer
  // download supersedes it). Without a signal the fetch and its RAM-buffered
  // bytes survive the component and keep consuming memory.
  const abortControllerRef = useRef<AbortController | null>(null);
  // Sync busy-guard for executeDownload: state updates land only after
  // re-render, so two clicks in the same tick both read isDownloadingFile
  // as false and would start two download_file invocations for one file.
  const isDownloadingRef = useRef(false);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
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
    // Race guard (2nd layer behind the disabled menu item): an item that is
    // still uploading has no playable media yet — downloading it would fetch a
    // non-existent file.
    if (isUploading(track.id)) {
      showErrorToast(t("upload.uploading_blocked"));
      return;
    }
    setDownloadTrack(track);
    setDownloadFileName(
      `${track.title} - ${track.artist || t("common.unknown")}`,
    );
    setShowDownloadDialog(true);
    setIsOpen(false);
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
    setShowDownloadDialog(false);

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    // Merge the cancel signal with a bounded timeout so a stalled server
    // cannot hold the RAM-buffered bytes forever (MDN AbortSignal.any /
    // AbortSignal.timeout; same pattern as useDrive.ts:72).
    const signal = mergeWithTimeoutSignal(
      controller.signal,
      DOWNLOAD_TIMEOUT_MS,
    );

    try {
      const freshToken = await getValidToken(false, signal);
      if (!freshToken) throw new Error("No valid token");

      const downloadUrl = `${DRIVE_FILES_URL}/${downloadTrack.id}?alt=media`;
      const response = await fetch(downloadUrl, {
        headers: authHeaders(freshToken),
        signal,
      });

      if (!response.ok) throw new Error("Fetch failed");

      const bytes = new Uint8Array(await response.arrayBuffer());
      const dir = await getEffectiveDownloadPath();
      if (getCustomDownloadPath()) {
        try {
          // Extend the fs scope so write_file may write outside the base
          // $DOWNLOAD scope (runtime scope extension, tauri_plugin_fs::FsExt).
          // If this fails the write itself rejects with a scope error — do
          // not block the main flow here, let write_file surface it.
          await invoke("register_download_path", { path: dir });
        } catch (scopeErr: unknown) {
          void captureError({
            level: "warn",
            source: "useMenuDownload",
            message: `Failed to extend fs scope for custom download dir: ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`,
          });
        }
      }
      const base = downloadFileName.trim() || "audio";
      const ext = downloadTrack.originalName?.includes(".")
        ? downloadTrack.originalName.slice(
            downloadTrack.originalName.lastIndexOf("."),
          )
        : ".mp3";
      const finalFileName = sanitizeFilename(
        `${base}${ext}`,
        t("menu.untitled"),
      );
      // join() uses the platform-specific separator (Tauri v2 path API) so a
      // POSIX build no longer writes a literal backslash into the file name.
      const savePath = await join(dir, finalFileName);

      // tauri-plugin-fs v2: write_file reads the target path from a request
      // header and takes the bytes as the raw invoke body. Passing the
      // Uint8Array as the top-level arg keeps the IPC on the octet-stream
      // path (no Array.from / JSON number-array, ~8x the file size in peak
      // memory). See plugin-fs guest-js writeFile() for the identical shape.
      await invoke("plugin:fs|write_file", bytes, {
        headers: { path: encodeURIComponent(savePath) },
      });

      setDownloadMessage(`${t("menu.saved_at")} ${savePath}`);
    } catch (err: unknown) {
      // Duck-typed name extraction: DOMException is NOT instanceof Error in
      // some environments (jsdom), yet carries a reliable .name. Still needed
      // here for 'TimeoutError' (AbortSignal.timeout) and the failure log —
      // the AbortError branch itself uses the shared isAbortError check.
      const errName =
        err &&
        typeof err === "object" &&
        typeof (err as { name?: unknown }).name === "string"
          ? (err as { name: string }).name
          : "";
      if (isAbortError(err)) {
        // Deliberate cancel (unmount / superseded download): the component may
        // already be gone, so do NOT touch state — and do not surface a
        // failure message for a user-initiated cancel. Log for visibility.
        void captureError({
          level: "warn",
          source: "useMenuDownload",
          message:
            "Download aborted — download was cancelled (unmount or superseded)",
        });
        return;
      }
      if (errName === "TimeoutError") {
        void captureError({
          level: "error",
          source: "useMenuDownload",
          message: `Download timeout — no response within ${String(DOWNLOAD_TIMEOUT_MS)}ms`,
        });
        setDownloadMessage(t("menu.download_failed"));
        return;
      }
      void captureError({
        level: "error",
        source: "useMenuDownload",
        message: `Download failed: ${errName || String(err)}`,
      });
      setDownloadMessage(t("menu.download_failed"));
    } finally {
      isDownloadingRef.current = false;
      setIsDownloadingFile(false);
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
    handleDownloadClick,
    executeDownload,
  };
}
