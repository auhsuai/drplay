import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Track } from "../../../../App";
import { getValidToken } from "../../../../utils/apiClient";
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
      const freshToken = await getValidToken();
      if (!freshToken) throw new Error("No valid token");
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${track.id}?alt=media`;
      const response = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${freshToken}` }
      });
      if (!response.ok) throw new Error("Fetch failed");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      const base = downloadFileName.trim() || 'audio';
      const ext = track.originalName?.includes('.') ? track.originalName.slice(track.originalName.lastIndexOf('.')) : '.mp3';
      a.download = `${base}${ext}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      try {
        const dir = await getEffectiveDownloadPath();
        setDownloadMessage(`${t('menu.saved_at', 'Đã lưu tại:')} ${dir}\\${a.download}`);
      } catch {
        setDownloadMessage(t('menu.download_complete', 'Tải xuống hoàn tất!'));
      }
    } catch {
      setDownloadMessage(t('menu.download_failed', 'Tải xuống thất bại'));
    } finally {
      setIsDownloadingFile(false);
    }
  };

  return { isDownloadingFile, showDownloadDialog, setShowDownloadDialog, downloadFileName, setDownloadFileName, downloadMessage, handleDownloadClick, executeDownload };
}
