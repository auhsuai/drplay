import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getValidToken } from '../utils/apiClient';
import { classifyDriveError, mergeWithTimeoutSignal } from '../utils/driveApi';
import { getTrackMetadata } from '../utils/metadata';
import { captureError } from '../utils/errorLog';

const TAURI_EVENT_QUOTA = 'drive-quota-exceeded';
const TAURI_EVENT_REPAIR_THUMBNAIL = 'repair-missing-thumbnail';
const WINDOW_EVENT_METADATA_UPDATED = 'metadata-updated';

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

// Uploads cover art to the local proxy server; shared by the thumb + full-size
// cover blocks so the fetch/signal/status-check logic lives in one place.
export async function uploadCover(
  url: string,
  data: Uint8Array,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(url, { method: 'POST', body: data, signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

export function useTauriEvents(setShowRateLimitModal: (v: boolean) => void) {
  useEffect(() => {
    let quotaFn: (() => void) | null = null;
    let repairFn: (() => void) | null = null;
    let cancelled = false;
    // Cancel in-flight cover uploads on unmount. Without a signal a stalled
    // upload would keep its resources after the component is gone.
    const controller = new AbortController();

    listen(TAURI_EVENT_QUOTA, () => {
      setShowRateLimitModal(true);
    }).then(fn => {
      if (cancelled) { fn(); return; }
      quotaFn = fn;
    });
    
    listen<{ driveFileId: string, dbId: string }>(TAURI_EVENT_REPAIR_THUMBNAIL, async (event) => {
      try {
        const token = await getValidToken();
        if (!token) return;

        const meta = await getTrackMetadata(event.payload.driveFileId, token, undefined, undefined, undefined, true);

        // Merge the unmount-cancel signal with a bounded timeout so a stalled
        // upload cannot hang the handler (MDN AbortSignal.any / timeout). Same
        // helper as useMenuDownload.ts / useDrive.ts.
        const signal = mergeWithTimeoutSignal(controller.signal, COVER_UPLOAD_TIMEOUT_MS);

        if (meta.pictureData) {
          try {
            await uploadCover(`http://drplay.localhost/cover/${event.payload.dbId}?thumb=true`, new Uint8Array(meta.pictureData), signal);
          } catch (err) {
            if (errName(err) === 'AbortError') {
              captureError({ level: 'warn', source: 'useTauriEvents', message: `Cover upload aborted for ${event.payload.dbId} (thumb)` });
            } else {
              captureError({ level: 'warn', source: 'useTauriEvents', message: `Cover upload failed for ${event.payload.dbId}: ${err instanceof Error ? err.message : String(err)}` });
            }
          }
        }
        if (meta.pictureDataFull) {
          try {
            await uploadCover(`http://drplay.localhost/cover/${event.payload.dbId}?thumb=false`, new Uint8Array(meta.pictureDataFull), signal);
          } catch (err) {
            if (errName(err) === 'AbortError') {
              captureError({ level: 'warn', source: 'useTauriEvents', message: `Cover upload aborted for ${event.payload.dbId} (full)` });
            } else {
              captureError({ level: 'warn', source: 'useTauriEvents', message: `Cover upload failed for ${event.payload.dbId} (full): ${err instanceof Error ? err.message : String(err)}` });
            }
          }
        }

        window.dispatchEvent(new CustomEvent(WINDOW_EVENT_METADATA_UPDATED, { detail: { fileId: event.payload.driveFileId } }));
      } catch (e: unknown) {
        captureError({ level: 'warn', source: 'useTauriEvents', message: `Repair thumbnail failed for ${event.payload.driveFileId}: ${classifyDriveError(e)}` });
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
