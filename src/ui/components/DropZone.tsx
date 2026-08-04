import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { statDiskPath } from "../../utils/diskFs";
import { startUploads, type UploadSeed } from "../../utils/uploadManager";
import { useDriveStore } from "../../store/driveStore";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { basename } from "../../utils/pathUtils";

const DROPZONE_MODULE = "DropZone";
// Bus between DropZone and folder cards: the OS drag is a Tauri event, not a
// DOM event, so cards cannot react via :hover. DropZone announces the hovered
// folder id; each folder card compares it against its own id.
export const DRAG_FOLDER_HOVER_EVENT = "drag-folder-hover";
// Bus between DropZone and MainContent: while a drag is in flight the header
// chrome (TopNavigationBar/SelectionToolbar) and pagination must hide so the
// drop target area is unambiguous. True on enter/over (anywhere), false on
// leave/drop.
export const DRAG_ACTIVE_EVENT = "drag-active";
// Attribute DropZone hit-tests against; SongCard sets it only on folder cards.
const FOLDER_HIT_ATTRIBUTE = "data-folder-id";
const FOLDER_HIT_SELECTOR = `[${FOLDER_HIT_ATTRIBUTE}]`;
// Identity fallback when devicePixelRatio is unavailable (non-browser env).
const NO_SCALE_FACTOR = 1;
// Probe-grid radius for folder hit-testing: the cursor often sits in the 12px
// (pb-3) gap between cards, where a single elementFromPoint misses. Offsets of
// 8px (> half the gap) guarantee the padding between two folders still
// resolves to one of them.
const HOVER_PROBE_OFFSET_PX = 8;

export interface DragPosition {
  x: number;
  y: number;
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
      const folderId = element
        .closest(FOLDER_HIT_SELECTOR)
        ?.getAttribute(FOLDER_HIT_ATTRIBUTE);
      if (folderId !== null && folderId !== undefined) return folderId;
    }
    return null;
  } catch (err) {
    void captureError({
      level: "warn",
      source: DROPZONE_MODULE,
      message: `drag-hit-test-failed: ${describeError(err)}`,
    });
    return null;
  }
}

function announceDragHover(folderId: string | null): void {
  window.dispatchEvent(
    new CustomEvent<{ folderId: string | null }>(DRAG_FOLDER_HOVER_EVENT, {
      detail: { folderId },
    }),
  );
}

function announceDragActive(active: boolean): void {
  window.dispatchEvent(
    new CustomEvent<{ active: boolean }>(DRAG_ACTIVE_EVENT, {
      detail: { active },
    }),
  );
}

// Classify one dropped path into an UploadSeed, or null when the path is not
// usable (missing on disk or stat failed). Never throws: a single bad path
// must not abort the rest of the drop batch.
async function toUploadSeed(
  path: string,
  parentId: string,
): Promise<UploadSeed | null> {
  let entry;
  try {
    entry = await statDiskPath(path);
  } catch (err) {
    void captureError({
      level: "warn",
      source: DROPZONE_MODULE,
      message: `drop-stat-failed name=${basename(path)}: ${describeError(err)}`,
    });
    return null;
  }
  if (entry === null) {
    void captureError({
      level: "warn",
      source: DROPZONE_MODULE,
      message: `drop-path-missing name=${basename(path)}`,
    });
    return null;
  }
  return {
    name: basename(path),
    isFolder: entry.isDirectory,
    parentId,
    diskPath: path,
  };
}

export interface DropZoneProps {
  token?: string | null | undefined;
}

export function DropZone({ token }: DropZoneProps) {
  const { t } = useTranslation();

  useEffect(() => {
    // Dropping before login is meaningless: the seeds would fail auth anyway.
    if (!token) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    const handleDrop = async (
      paths: string[],
      parentId: string,
    ): Promise<void> => {
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
        showErrorToast(t("upload.drop_failed"));
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
              case "enter":
              case "over": {
                const folderId = hitTestFolderId(payload.position);
                if (folderId !== null) {
                  announceDragHover(folderId);
                } else {
                  announceDragHover(null);
                }
                announceDragActive(true);
                break;
              }
              case "leave":
                announceDragHover(null);
                announceDragActive(false);
                break;
              case "drop": {
                announceDragHover(null);
                announceDragActive(false);
                // Handle independently of any prior 'over' — a drop can land
                // without a prior hover event (fast drags).
                const folderId = hitTestFolderId(payload.position);
                // Read at drop time, not at mount: the user may have navigated
                // folders since the listener was registered. A drop over a
                // folder card overrides the current folder.
                const parentId =
                  folderId ?? useDriveStore.getState().currentFolderId;
                void handleDrop(payload.paths, parentId);
                break;
              }
              default:
                break;
            }
          } catch (err) {
            void captureError({
              level: "warn",
              source: DROPZONE_MODULE,
              message: `drag-event-failed: ${describeError(err)}`,
            });
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
        void captureError({
          level: "warn",
          source: DROPZONE_MODULE,
          message: `drag-drop-listener-failed: ${describeError(err)}`,
        });
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
