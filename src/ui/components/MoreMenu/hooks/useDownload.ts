import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { Track } from "../../../../App";
import { getEffectiveDownloadPath } from "../../../../utils/downloadPath";

export function useDownload(track?: Track) {
  const { t } = useTranslation();
  const [isDownloadingFile, setIsDownloadingFile] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [downloadFileName, setDownloadFileName] = useState("");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);

  useEffect(() => {
    if (downloadMessage) {
      const timer = setTimeout(() => setDownloadMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [downloadMessage]);

  const handleDownloadClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!track) return;
    setDownloadFileName(track.title);
    setShowDownloadDialog(true);
  };

  const executeDownload = async () => {
    if (isDownloadingFile || !track) return;
    setIsDownloadingFile(true);
    setShowDownloadDialog(false);
    try {
      // Streams the file straight to disk via a Rust command instead of
      // buffering the whole file as a Blob in renderer memory first (the
      // previous approach here) -- keeps memory bounded regardless of file
      // size, which matters for large lossless FLAC tracks.
      const dir = await getEffectiveDownloadPath();
      const base = downloadFileName.trim() || 'audio';
      const ext = track.originalName?.includes('.') ? track.originalName.slice(track.originalName.lastIndexOf('.')) : '.mp3';
      const filename = `${base}${ext}`;
      const destPath = await join(dir, filename);
      await invoke("download_file_to_disk", { fileId: track.id, destPath });
      setDownloadMessage(`${t('menu.saved_at', 'Đã lưu tại:')} ${destPath}`);
    } catch {
      setDownloadMessage(t('menu.download_failed', 'Tải xuống thất bại'));
    } finally {
      setIsDownloadingFile(false);
    }
  };

  return { isDownloadingFile, showDownloadDialog, setShowDownloadDialog, downloadFileName, setDownloadFileName, downloadMessage, handleDownloadClick, executeDownload };
}
