import { useState, useEffect } from 'react';
import { getValidToken } from '../utils/apiClient';
import { getEffectiveDownloadPath } from '../utils/downloadPath';
import { Track } from '../App';
import { TFunction } from 'i18next';

export function useMenuDownload(t: TFunction) {
  const [isDownloadingFile, setIsDownloadingFile] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [downloadFileName, setDownloadFileName] = useState("");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadTrack, setDownloadTrack] = useState<Track | null>(null);

  useEffect(() => {
    if (downloadMessage) {
      const timer = setTimeout(() => setDownloadMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [downloadMessage]);

  const handleDownloadClick = (e: React.MouseEvent, track: Track | undefined, setIsOpen: (o: boolean) => void) => {
    e.stopPropagation();
    if (!track) return;
    setDownloadTrack(track);
    setDownloadFileName(`${track.title} - ${track.artist || 'Unknown'}`);
    setShowDownloadDialog(true);
    setIsOpen(false);
  };

  const executeDownload = async () => {
    if (isDownloadingFile || !downloadTrack) return;
    setIsDownloadingFile(true);
    setShowDownloadDialog(false);
    
    try {
      const freshToken = await getValidToken();
      if (!freshToken) throw new Error("No valid token");

      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${downloadTrack.id}?alt=media`;
      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${freshToken}`
        }
      });
      
      if (!response.ok) throw new Error("Fetch failed");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      const base = downloadFileName.trim() || 'audio';
      const ext = downloadTrack.originalName?.includes('.') ? downloadTrack.originalName.slice(downloadTrack.originalName.lastIndexOf('.')) : '.mp3';
      const finalFileName = `${base}${ext}`;
      a.download = finalFileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      try {
        const dir = await getEffectiveDownloadPath();
        setDownloadMessage(`${t('menu.saved_at', 'Đã lưu tại:')} ${dir}\\${finalFileName}`);
      } catch (e) {
        setDownloadMessage(t('menu.download_complete', 'Tải xuống hoàn tất!'));
      }
    } catch (err) {
      console.error('[useMenuDownload] Failed to download file', err);
      setDownloadMessage(t('menu.download_failed', 'Tải xuống thất bại'));
    } finally {
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
    handleDownloadClick,
    executeDownload
  };
}
