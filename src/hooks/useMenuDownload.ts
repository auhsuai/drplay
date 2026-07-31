import { useState, useEffect, useRef } from 'react';
import { getValidToken } from '../utils/apiClient';
import { getEffectiveDownloadPath } from '../utils/downloadPath';
import { captureError } from '../utils/errorLog';
import { Track } from '../App';
import { TFunction } from 'i18next';

// Delay the object URL revoke so the engine gets a chance to schedule the
// download (it runs on a later tick). Revoking synchronously after a.click()
// can free the URL before the download starts, yielding empty/corrupt files
// on some engines (MDN URL.revokeObjectURL: "avoid freeing the object URL
// too early"; Koine #623 / techbloat 2026-05 recommend ~1s).
const REVOKE_DELAY_MS = 1000;

// The download buffers the ENTIRE file into RAM via response.blob(), so an
// unresponsive server would hold the bytes (and memory) forever. 5 minutes is
// generous for legit multi-hundred-MB audio files yet still bounds the
// pathological case. AbortSignal.timeout rejects with a DOMException named
// 'TimeoutError' (MDN AbortSignal.timeout, Baseline 2024). Same pattern as
// fetchWithAuth / useDrive.ts.
const DOWNLOAD_TIMEOUT_MS = 300_000;

export function useMenuDownload(t: TFunction) {
  const [isDownloadingFile, setIsDownloadingFile] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [downloadFileName, setDownloadFileName] = useState("");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadTrack, setDownloadTrack] = useState<Track | null>(null);

  // Abort the in-flight download when the component unmounts (or a newer
  // download supersedes it). Without a signal the fetch and its RAM-buffered
  // blob survive the component and keep consuming memory.
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

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

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    // Merge the cancel signal with a bounded timeout so a stalled server
    // cannot hold the RAM-buffered blob forever (MDN AbortSignal.any /
    // AbortSignal.timeout; same pattern as useDrive.ts:72).
    const signal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
      : controller.signal;

    try {
      const freshToken = await getValidToken(false, signal);
      if (!freshToken) throw new Error("No valid token");

      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${downloadTrack.id}?alt=media`;
      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${freshToken}`
        },
        signal
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
      setTimeout(() => window.URL.revokeObjectURL(url), REVOKE_DELAY_MS);
      document.body.removeChild(a);
      
      try {
        const dir = await getEffectiveDownloadPath();
        setDownloadMessage(`${t('menu.saved_at', 'Đã lưu tại:')} ${dir}\\${finalFileName}`);
      } catch (e: unknown) {
        setDownloadMessage(t('menu.download_complete', 'Tải xuống hoàn tất!'));
      }
    } catch (err: unknown) {
      // Duck-typed name extraction: DOMException is NOT instanceof Error in
      // some environments (jsdom), yet carries a reliable .name ('AbortError'
      // for cancels, 'TimeoutError' for AbortSignal.timeout).
      const errName = err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string'
        ? (err as { name: string }).name
        : '';
      if (errName === 'AbortError') {
        // Deliberate cancel (unmount / superseded download): the component may
        // already be gone, so do NOT touch state — and do not surface a
        // failure message for a user-initiated cancel. Log for visibility.
        captureError({ level: 'warn', source: 'useMenuDownload', message: 'Download aborted — download was cancelled (unmount or superseded)' });
        return;
      }
      if (errName === 'TimeoutError') {
        captureError({ level: 'error', source: 'useMenuDownload', message: `Download timeout — no response within ${DOWNLOAD_TIMEOUT_MS}ms` });
        setDownloadMessage(t('menu.download_failed', 'Tải xuống thất bại'));
        return;
      }
      captureError({ level: 'error', source: 'useMenuDownload', message: `Download failed: ${errName || String(err)}` });
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
