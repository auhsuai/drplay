import { useEffect, useState } from 'react';
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
// Bus between DropZone and folder cards: the OS drag is a Tauri event, not a
// DOM event, so cards cannot react via :hover. DropZone announces the hovered
// folder id; each folder card compares it against its own id.
export const DRAG_FOLDER_HOVER_EVENT = 'drag-folder-hover';
// Bus between DropZone and MainContent: while a drag is in flight the header
// chrome (TopNavigationBar/SelectionToolbar) and pagination must hide so the
// drop target area is unambiguous. True on enter/over (anywhere), false on
// leave/drop.
export const DRAG_ACTIVE_EVENT = 'drag-active';
// Attribute DropZone hit-tests against; SongCard sets it only on folder cards.
const FOLDER_HIT_ATTRIBUTE = 'data-folder-id';
const FOLDER_HIT_SELECTOR = `[${FOLDER_HIT_ATTRIBUTE}]`;
// Element that scopes the dim mask: the file-list container in MainContent.
// The overlay covers exactly this rect so the sidebar/playerbar/header stay
// light while dragging.
const DROP_REGION_SELECTOR = '[data-drop-region]';
// Identity fallback when devicePixelRatio is unavailable (non-browser env).
const NO_SCALE_FACTOR = 1;
// Probe-grid radius for folder hit-testing: the cursor often sits in the 12px
// (pb-3) gap between cards, where a single elementFromPoint misses. Offsets of
// 8px (> half the gap) guarantee padding between two folders still resolves
// to one of them, so the mask never flashes full-region over a gap.
const HOVER_PROBE_OFFSET_PX = 8;

export interface DragPosition {
  x: number;
  y: number;
}

// Viewport rect of the drop region; the mask is rendered fixed at these
// coordinates (getBoundingClientRect is viewport-relative).
export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Tauri reports the cursor in physical pixels while elementFromPoint works in
// CSS pixels, so scale by the devicePixelRatio (1 on 100% scaling).
function toCssPosition(position: DragPosition): DragPosition {
  const scale = window.devicePixelRatio || NO_SCALE_FACTOR;
  return { x: position.x / scale, y: position.y / scale };
}

// Probe grid around the cursor (center + ±8px cross). The card gap (pb-3) is
// 12px, so probing at ±8px keeps the padding between two folders attached to
// one of them instead of degrading to "empty space" (full-region mask).
function probePointsAround(center: DragPosition): DragPosition[] {
  return [
    center,
    { x: center.x, y: center.y - HOVER_PROBE_OFFSET_PX },
    { x: center.x, y: center.y + HOVER_PROBE_OFFSET_PX },
    { x: center.x - HOVER_PROBE_OFFSET_PX, y: center.y },
    { x: center.x + HOVER_PROBE_OFFSET_PX, y: center.y },
  ];
}

// Resolve the folder card under the cursor (if any) across the probe grid.
// elementFromPoint may return a child of the card (icon/text), hence
// closest(). Null when no probe lands on a folder or hit-testing is
// unavailable (non-Tauri/jsdom).
function hitTestFolderId(position: DragPosition): string | null {
  try {
    const pt = toCssPosition(position);
    for (const probe of probePointsAround(pt)) {
      const element = document.elementFromPoint(probe.x, probe.y);
      if (element === null) continue;
      const folderId = element.closest(FOLDER_HIT_SELECTOR)?.getAttribute(FOLDER_HIT_ATTRIBUTE);
      if (folderId !== null && folderId !== undefined) return folderId;
    }
    return null;
  } catch (err) {
    captureError({ level: 'warn', source: DROPZONE_MODULE, message: `drag-hit-test-failed: ${describeError(err)}` });
    return null;
  }
}

function announceDragHover(folderId: string | null): void {
  window.dispatchEvent(new CustomEvent<{ folderId: string | null }>(DRAG_FOLDER_HOVER_EVENT, { detail: { folderId } }));
}

function announceDragActive(active: boolean): void {
  window.dispatchEvent(new CustomEvent<{ active: boolean }>(DRAG_ACTIVE_EVENT, { detail: { active } }));
}

function isInsideRect(point: DragPosition, rect: OverlayRect): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

// Re-read the region rect on every event: the user may scroll or the window
// may resize mid-drag, and a stale rect would dim the wrong area.
function getDropRegionRect(): OverlayRect | null {
  try {
    const region = document.querySelector(DROP_REGION_SELECTOR);
    if (region === null) return null;
    const rect = region.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  } catch (err) {
    captureError({ level: 'warn', source: DROPZONE_MODULE, message: `drop-region-rect-failed: ${describeError(err)}` });
    return null;
  }
}

// The mask is only meaningful while the cursor is over the file list: dimming
// the sidebar/playerbar/header during a drag would make the app look broken.
// Outside the region (or when the region is absent, e.g. Home tab) → no mask.
function resolveOverlayRect(position: DragPosition): OverlayRect | null {
  try {
    const rect = getDropRegionRect();
    if (rect === null) return null;
    const pt = toCssPosition(position);
    return isInsideRect(pt, rect) ? rect : null;
  } catch (err) {
    captureError({ level: 'warn', source: DROPZONE_MODULE, message: `drag-overlay-rect-failed: ${describeError(err)}` });
    return null;
  }
}

// Bail out when the rect is unchanged so high-frequency 'over' events do not
// re-render the overlay (V1's boolean state bailed on identical values).
function rectEquals(a: OverlayRect | null, b: OverlayRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
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
  // Rect tracking only exists to hit-test the drop region (and keep the
  // state machinery alive); no overlay is rendered from it anymore.
  const [, setOverlayRect] = useState<OverlayRect | null>(null);

  useEffect(() => {
    // Dropping before login is meaningless: the seeds would fail auth anyway.
    if (!token) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    const handleDrop = async (paths: string[], parentId: string): Promise<void> => {
      // A drop event may arrive in-flight AFTER the effect was cleaned up
      // (token change / unmount) — its closure must not process anything.
      if (cancelled) return;
      if (paths.length === 0) return;
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
          try {
            const payload = event.payload;
            switch (payload.type) {
              // Tauri emits 'enter' before 'over'; both mean "hovering now".
              case 'enter':
              case 'over': {
                const folderId = hitTestFolderId(payload.position);
                if (folderId !== null) {
                  // Over a folder card: no mask, the card highlights instead.
                  setOverlayRect((prev) => (rectEquals(prev, null) ? prev : null));
                  announceDragHover(folderId);
                } else {
                  // Empty area: mask only the file-list rect (never the
                  // sidebar/playerbar/header); outside it → no mask at all.
                  announceDragHover(null);
                  const next = resolveOverlayRect(payload.position);
                  setOverlayRect((prev) => (rectEquals(prev, next) ? prev : next));
                }
                announceDragActive(true);
                break;
              }
              case 'leave':
                setOverlayRect((prev) => (rectEquals(prev, null) ? prev : null));
                announceDragHover(null);
                announceDragActive(false);
                break;
              case 'drop':
                setOverlayRect((prev) => (rectEquals(prev, null) ? prev : null));
                announceDragHover(null);
                announceDragActive(false);
                // Handle independently of any prior 'over' — a drop can land
                // without our overlay ever having shown (fast drags).
                const folderId = hitTestFolderId(payload.position);
                // Read at drop time, not at mount: the user may have navigated
                // folders since the listener was registered. A drop over a
                // folder card overrides the current folder.
                const parentId = folderId ?? useDriveStore.getState().currentFolderId;
                void handleDrop(payload.paths, parentId);
                break;
              default:
                break;
            }
          } catch (err) {
            captureError({ level: 'warn', source: DROPZONE_MODULE, message: `drag-event-failed: ${describeError(err)}` });
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

  // The dim overlay was removed on user feedback — dragging files in must not
  // darken the whole app. Drop listeners above stay fully functional.
  return null;
}
