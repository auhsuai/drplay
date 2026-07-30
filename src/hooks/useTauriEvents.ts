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

export function useTauriEvents(setShowRateLimitModal: (v: boolean) => void) {
  useEffect(() => {
    let quotaFn: (() => void) | null = null;
    let repairFn: (() => void) | null = null;
    let cancelled = false;

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

        if (meta.pictureData) {
          await fetch(`http://drplay.localhost/cover/${event.payload.dbId}?thumb=true`, {
            method: 'POST',
            body: meta.pictureData as any,
          }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); }).catch(err => console.warn('[App] cover-upload-failed', { dbId: event.payload.dbId, thumb: true, err }));
        }
        if (meta.pictureDataFull) {
          await fetch(`http://drplay.localhost/cover/${event.payload.dbId}?thumb=false`, {
            method: 'POST',
            body: meta.pictureDataFull as any,
          }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); }).catch(err => console.warn('[App] cover-upload-failed', { dbId: event.payload.dbId, thumb: false, err }));
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
      quotaFn?.();
      repairFn?.();
    };
  }, [setShowRateLimitModal]);
}
