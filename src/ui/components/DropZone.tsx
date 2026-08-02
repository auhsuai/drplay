import { useEffect, useState } from 'react';
import { CloudUpload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { statDiskPath } from '../../utils/diskFs';
import { startUploads, type UploadSeed } from '../../utils/uploadManager';
import { useDriveStore } from '../../store/driveStore';
import { showErrorToast } from '../../utils/simpleToast';
import { captureError } from '../../utils/errorLog';
import { basename } from '../../utils/pathUtils';

const DROPZONE_MODULE = 'DropZone';
// Overlay must sit above every other layer (modals use z-50); Tauri's native
// drag-drop events are not DOM events, so the overlay only needs to LOOK like
// a full-window mask — pointer-events-none keeps it from blocking clicks.
const OVERLAY_Z_CLASS = 'z-[10000]';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Classify one dropped path into an UploadSeed, or null when the path is not
// usable (missing on disk or stat failed). Never throws: a single bad path
// must not abort the rest of the drop batch.
async function toUploadSeed(path: string, parentId: string): Promise<UploadSeed | null> {
  let entry;
  try {
    entry = await statDiskPath(path);
  } catch (err) {
    captureError({ level: 'warn', source: DROPZONE_MODULE, message: `drop-stat-failed name=${basename(path)}: ${describeError(err)}` });
    return null;
  }
  if (entry === null) {
    captureError({ level: 'warn', source: DROPZONE_MODULE, message: `drop-path-missing name=${basename(path)}` });
    return null;
  }
  return { name: basename(path), isFolder: entry.isDirectory, parentId, diskPath: path };
}

export interface DropZoneProps {
  token?: string | null;
}

export function DropZone({ token }: DropZoneProps) {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    // Dropping before login is meaningless: the seeds would fail auth anyway.
    if (!token) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    const handleDrop = async (paths: string[]): Promise<void> => {
      // A drop event may arrive in-flight AFTER the effect was cleaned up
      // (token change / unmount) — its closure must not process anything.
      if (cancelled) return;
      if (paths.length === 0) return;
      // Read at drop time, not at mount: the user may have navigated folders
      // since the listener was registered.
      const parentId = useDriveStore.getState().currentFolderId;
      const seeds: UploadSeed[] = [];
      for (const path of paths) {
        const seed = await toUploadSeed(path, parentId);
        if (seed !== null) seeds.push(seed);
      }
      // All paths unusable (e.g. moved/deleted meanwhile) → one toast for the
      // whole batch; per-path failures are logged silently above.
      if (seeds.length === 0) {
        showErrorToast(t('upload.drop_failed'));
        return;
      }
      startUploads(seeds, token);
    };

    const register = async (): Promise<void> => {
      try {
        const webview = getCurrentWebview();
        const fn = await webview.onDragDropEvent((event) => {
          switch (event.payload.type) {
            // Tauri emits 'enter' before 'over'; both mean "hovering now".
            case 'enter':
            case 'over':
              setIsDragOver(true);
              break;
            case 'leave':
              setIsDragOver(false);
              break;
            case 'drop':
              setIsDragOver(false);
              // Handle independently of any prior 'over' — a drop can land
              // without our overlay ever having shown (fast drags).
              void handleDrop(event.payload.paths);
              break;
            default:
              break;
          }
        });
        // Registration may resolve after the effect was cleaned up (unmount or
        // token change) — release the listener immediately in that case.
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (err) {
        // Outside Tauri (plain browser) getCurrentWebview throws and
        // onDragDropEvent rejects — drop support is optional here; the app
        // must keep working without it.
        captureError({ level: 'warn', source: DROPZONE_MODULE, message: `drag-drop-listener-failed: ${describeError(err)}` });
      }
    };

    void register();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [token, t]);

  if (!isDragOver) return null;

  return (
    <div data-testid="drop-overlay" className={`fixed inset-0 ${OVERLAY_Z_CLASS} bg-black/50 pointer-events-none flex items-center justify-center`}>
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/80 bg-white/10 px-10 py-8">
        <CloudUpload className="w-12 h-12 text-white" />
        <p className="text-lg font-medium text-white">{t('upload.drop_overlay')}</p>
      </div>
    </div>
  );
}
