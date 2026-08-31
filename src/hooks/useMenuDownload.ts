import { useState, useEffect, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getValidToken } from "../utils/apiClient";
import {
  getEffectiveDownloadPath,
  getCustomDownloadPath,
  getMobileDownloadFolder,
} from "../utils/downloadPath";
import { DRIVE_FILES_URL } from "../utils/driveFiles";
import { isUploading } from "../utils/uploadManager";
import { showErrorToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";
import { IS_MOBILE } from "../utils/platform";
import type { Track } from "../types";
import type { TFunction } from "i18next";

type DownloadEvent =
  | { event: "Started"; downloadId: number; total: number | null }
  | { event: "Progress"; downloaded: number }
  | { event: "Finished" }
  | { event: "Error"; message: string };

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
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded: number;
    total: number | null;
  } | null>(null);

  const mountedRef = useRef(true);
  const downloadIdRef = useRef<number | null>(null);
  // Sync busy-guard for executeDownload: state updates land only after
  // re-render, so two clicks in the same tick both read isDownloadingFile
  // as false and would start two download_file invocations for one file.
  const isDownloadingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cancel any in-flight download on unmount
      if (downloadIdRef.current !== null) {
        void invoke("cancel_download", { downloadId: downloadIdRef.current });
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
    setDownloadProgress(null);

    try {
      const freshToken = await getValidToken(false);
      if (!freshToken) throw new Error("No valid token");

      const downloadUrl = `${DRIVE_FILES_URL}/${downloadTrack.id}?alt=media`;
      const dir = await getEffectiveDownloadPath();
      // Mobile downloads go to the app dir (never $DOWNLOAD), which sits
      // outside the fs write scope (capabilities allow $DOWNLOAD/**) — extend
      // the scope unconditionally there. Desktop: only when the user picked a
      // custom dir outside the default scope.
      if (IS_MOBILE || getCustomDownloadPath()) {
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

      // Rust streaming download: bytes never touch the WebView heap.
      const onEvent = new Channel<DownloadEvent>();
      onEvent.onmessage = (msg) => {
        if (!mountedRef.current) return;
        if (msg.event === "Started") {
          downloadIdRef.current = msg.downloadId;
          setDownloadProgress({ downloaded: 0, total: msg.total });
        } else if (msg.event === "Progress") {
          setDownloadProgress((prev) => ({
            downloaded: msg.downloaded,
            total: prev?.total ?? null,
          }));
        }
      };

      const savePath = await invoke("download_file", {
        url: downloadUrl,
        token: freshToken,
        destDir: dir,
        fileName: finalFileName,
        onProgress: onEvent,
      });

      if (!mountedRef.current) return;

      // Task 4 mobile-polish (SAF): with a user-picked Android folder, the
      // file written above is a STAGED copy in app-private storage — hand it
      // to the saf-download plugin, which streams it into the picked
      // content-URI tree (DocumentFile + ContentResolver) and deletes the
      // staged copy. Without a picked folder the fallback below (app dir)
      // is exactly the pre-Task-4 behavior.
      if (IS_MOBILE) {
        const mobileFolder = getMobileDownloadFolder();
        if (mobileFolder) {
          try {
            await invoke("plugin:saf-download|save_file", {
              uri: mobileFolder.uri,
              fileName: finalFileName,
              stagedPath: savePath,
            });
          } catch (saveErr: unknown) {
            const saveMsg =
              saveErr &&
              typeof saveErr === "object" &&
              typeof (saveErr as { message?: unknown }).message === "string"
                ? (saveErr as { message: string }).message
                : String(saveErr);
            // Classify per Luật 4: permission loss on the persisted tree is
            // the most actionable failure — the user must re-pick the folder.
            if (saveMsg.includes("permission_denied")) {
              void captureError({
                level: "error",
                source: "useMenuDownload",
                message: `SAF save failed — write permission lost on the picked folder (${mobileFolder.name}): ${saveMsg}`,
              });
              setDownloadMessage(
                t("menu.saved_folder_lost_permission", {
                  defaultValue:
                    "Download failed — folder access was revoked. Re-pick it in Settings.",
                }),
              );
            } else {
              void captureError({
                level: "error",
                source: "useMenuDownload",
                message: `SAF save failed (${mobileFolder.name}): ${saveMsg}`,
              });
              setDownloadMessage(t("menu.download_failed"));
            }
            return;
          }
          setDownloadMessage(
            t("menu.saved_at_folder", { folder: mobileFolder.name }),
          );
          return;
        }
        // Fallback: no folder picked yet — app-private storage (pre-Task-4).
        setDownloadMessage(
          t("menu.saved_at_app", { defaultValue: "Saved to app storage" }),
        );
        return;
      }
      setDownloadMessage(`${t("menu.saved_at")} ${String(savePath)}`);
    } catch (err: unknown) {
      // Rust commands reject with a string message, not an Error object.
      const errMsg =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : String(err);

      if (errMsg === "download cancelled") {
        void captureError({
          level: "warn",
          source: "useMenuDownload",
          message: "Download cancelled",
        });
        return;
      }

      void captureError({
        level: "error",
        source: "useMenuDownload",
        message: `Download failed: ${errMsg}`,
      });
      setDownloadMessage(t("menu.download_failed"));
    } finally {
      isDownloadingRef.current = false;
      if (mountedRef.current) {
        setIsDownloadingFile(false);
        downloadIdRef.current = null;
      }
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
    downloadProgress,
    handleDownloadClick,
    executeDownload,
  };
}
