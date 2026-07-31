import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getValidToken } from '../utils/apiClient';
import { getTrackMetadata } from '../utils/metadata';

function classifyAppError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown-error";
  const m = msg.toLowerCase();
  if (m.includes("timeout") || m.includes("aborterror")) return "timeout";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("unreachable"))
    return "network";
  const statusMatch = m.match(/\((\d{3})\)/);
  if (statusMatch) return `http-${statusMatch[1]}`;
  return "unknown";
}

// Cover thumbnails are uploaded to the local proxy server; 30s is generous for
// a multi-MB full-size cover yet still bounds a stalled upload. AbortSignal.timeout
// rejects with a 'TimeoutError' DOMException; AbortController.abort() with an
// 'AbortError' (MDN AbortSignal.timeout / AbortSignal.any, Baseline 2024). Same
// pattern as useMenuDownload.ts / useDrive.ts.
const COVER_UPLOAD_TIMEOUT_MS = 30_000;

// Duck-typed name extraction: DOMException is NOT instanceof Error in some
// environments (jsdom), yet carries a reliable .name ('AbortError' for
// deliberate cancels). Same rationale as useMenuDownload.ts.
function errName(err: unknown): string {
  return err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string'
    ? (err as { name: string }).name
    : '';
}

export function useTauriEvents(setShowRateLimitModal: (v: boolean) => void) {
  useEffect(() => {
    let quotaFn: (() => void) | null = null;
    let repairFn: (() => void) | null = null;
    let cancelled = false;
    // Cancel in-flight cover uploads on unmount. Without a signal a stalled
    // upload would keep its resources after the component is gone.
    const controller = new AbortController();

    listen('drive-quota-exceeded', () => {
      setShowRateLimitModal(true);
    }).then(fn => {
      if (cancelled) { fn(); return; }
      quotaFn = fn;
    });
    
    listen<{ driveFileId: string, dbId: string }>('repair-missing-thumbnail', async (event) => {
      try {
        const token = await getValidToken();
        if (!token) return;

        const meta = await getTrackMetadata(event.payload.driveFileId, token, undefined, undefined, undefined, true);

        // Merge the unmount-cancel signal with a bounded timeout so a stalled
        // upload cannot hang the handler (MDN AbortSignal.any / timeout).
        const signal = typeof AbortSignal.any === 'function'
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(COVER_UPLOAD_TIMEOUT_MS)])
          : controller.signal;

        if (meta.pictureData) {
          await fetch(`http://drplay.localhost/cover/${event.payload.dbId}?thumb=true`, {
            method: 'POST',
            body: meta.pictureData as any,
            signal,
          }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); }).catch(err => {
            if (errName(err) === 'AbortError') {
              console.warn('[App] cover-upload-aborted', { dbId: event.payload.dbId, thumb: true });
              return;
            }
            console.warn('[App] cover-upload-failed', { dbId: event.payload.dbId, thumb: true, err });
          });
        }
        if (meta.pictureDataFull) {
          await fetch(`http://drplay.localhost/cover/${event.payload.dbId}?thumb=false`, {
            method: 'POST',
            body: meta.pictureDataFull as any,
            signal,
          }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); }).catch(err => {
            if (errName(err) === 'AbortError') {
              console.warn('[App] cover-upload-aborted', { dbId: event.payload.dbId, thumb: false });
              return;
            }
            console.warn('[App] cover-upload-failed', { dbId: event.payload.dbId, thumb: false, err });
          });
        }

        window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId: event.payload.driveFileId } }));
      } catch (e) {
        console.warn(`[useTauriEvents] repair-thumbnail-failed`, { driveFileId: event.payload.driveFileId, error: classifyAppError(e) });
      }
    }).then(fn => {
      if (cancelled) { fn(); return; }
      repairFn = fn;
    });

    return () => {
      cancelled = true;
      controller.abort();
      quotaFn?.();
      repairFn?.();
    };
  }, [setShowRateLimitModal]);
}
