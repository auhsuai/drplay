import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../types";
import type { Playlist } from "../../utils/playlists";
import { updatePlaylist } from "../../utils/playlists";
import { captureError } from "../../utils/errorLog";
import { showErrorToast } from "../../utils/simpleToast";
import { applyArrangeDrop, resolveArrangeDrop } from "./arrangeReorder";
import { PLAYLIST_VIEW_MODULE } from "./usePlaylistData";

// Same threshold convention as useHorizontalScroll: a gesture only becomes a
// drag after this much movement, so the pointerup still fires the row's click.
const ARRANGE_DRAG_THRESHOLD_PX = 5;

// Pointer-drag session for Arrange mode. The tracks/selection snapshots are
// taken at gesture start: the drop must resolve against exactly the list the
// user saw when the drag began (persist happens once, on drop, §21/§22).
export interface ArrangeDragState {
  pointerId: number;
  startY: number;
  isDragging: boolean;
  insertionIndex: number | null;
  captureEl: HTMLElement;
  tracksSnapshot: Track[];
  selectedSnapshot: Set<string>;
}

export interface ArrangeDragPreview {
  active: boolean;
  indicatorY: number | null;
}

interface UsePlaylistArrangeOptions {
  playlistId: string;
  tracks: Track[];
  selected: Set<string>;
  setPlaylist: Dispatch<SetStateAction<Playlist | null>>;
  exitSelection: () => void;
}

interface UsePlaylistArrangeResult {
  arrangeMode: boolean;
  dragPreview: ArrangeDragPreview;
  listRef: RefObject<HTMLDivElement | null>;
  suppressRowClickRef: RefObject<boolean>;
  enterArrangeMode: () => void;
  handleArrangeDone: () => void;
  handleArrangeCancel: () => void;
  handleRowPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
  resetArrange: () => void;
}

export function usePlaylistArrange({
  playlistId,
  tracks,
  selected,
  setPlaylist,
  exitSelection,
}: UsePlaylistArrangeOptions): UsePlaylistArrangeResult {
  const { t } = useTranslation();
  const [arrangeMode, setArrangeMode] = useState(false);
  const [dragPreview, setDragPreview] = useState<ArrangeDragPreview>({
    active: false,
    indicatorY: null,
  });
  const listRef = useRef<HTMLDivElement>(null);
  // Set on drag end so the pointerup's synthetic click cannot toggle the row
  // that was just dragged; cleared on the next pointerdown.
  const suppressRowClickRef = useRef(false);
  const dragRef = useRef<ArrangeDragState | null>(null);
  const dragHandlersRef = useRef<{
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);

  useEffect(() => {
    return () => {
      // Unmount mid-drag must not leave window listeners behind. Uses the ref
      // directly (the drag helpers below are not initialized on the
      // early-return path above).
      const handlers = dragHandlersRef.current;
      if (handlers === null) return;
      window.removeEventListener("pointermove", handlers.move);
      window.removeEventListener("pointerup", handlers.end);
      window.removeEventListener("pointercancel", handlers.end);
      dragHandlersRef.current = null;
    };
  }, []);

  // Arrange mode is only reachable with a non-empty selection (§4.1/Case 8);
  // entering keeps the current selection, which IS the dragged group (§7.1).
  const enterArrangeMode = () => {
    if (selected.size === 0) return;
    setArrangeMode(true);
  };

  // Done: leave arrange, stay in select mode with the selection kept — the
  // user can continue with Remove/Arrange (the plan's §13 "keep" branch).
  const handleArrangeDone = () => {
    setArrangeMode(false);
  };

  // Cancel: abandon the whole batch flow (arrange + select mode), mirroring
  // the toolbar X — the order already persisted per drop is NOT reverted.
  const handleArrangeCancel = () => {
    exitSelection();
  };

  const detachDragListeners = () => {
    const handlers = dragHandlersRef.current;
    if (handlers === null) return;
    window.removeEventListener("pointermove", handlers.move);
    window.removeEventListener("pointerup", handlers.end);
    window.removeEventListener("pointercancel", handlers.end);
    dragHandlersRef.current = null;
  };

  // Optimistic local order, then ONE persist per drop (§21/#22). On failure
  // the local order rolls back to the pre-drop snapshot so the UI never shows
  // an order the data layer does not have; the data layer already toasted.
  const persistArrangeOrder = async (
    previousTracks: Track[],
    nextTracks: Track[],
  ) => {
    setPlaylist((prev) => (prev ? { ...prev, tracks: nextTracks } : prev));
    const rollback = () => {
      setPlaylist((prev) =>
        prev && prev.tracks === nextTracks
          ? { ...prev, tracks: previousTracks }
          : prev,
      );
    };
    try {
      const updated = await updatePlaylist(playlistId, {
        tracks: nextTracks,
      });
      if (updated === null) rollback();
    } catch (err) {
      rollback();
      void captureError({
        level: "error",
        source: PLAYLIST_VIEW_MODULE,
        message: `arrange-persist-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("playlist.update_error"));
    }
  };

  const commitArrangeDrop = (
    drag: ArrangeDragState,
    insertionIndex: number,
  ) => {
    const next = applyArrangeDrop(
      drag.tracksSnapshot,
      drag.selectedSnapshot,
      insertionIndex,
    );
    // Same reference → the drop resolves to the current order (dropped inside
    // the group's own region, §9.2): no mutation, no persist, arrange stays.
    if (next === drag.tracksSnapshot) return;
    void persistArrangeOrder(drag.tracksSnapshot, next);
  };

  const handleRowPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    trackId: string,
  ) => {
    suppressRowClickRef.current = false;
    if (!arrangeMode) return;
    if (event.button !== 0) return;
    if (!selected.has(trackId)) return;
    // Nested controls (checkbox) own their gestures.
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input,button,a")) {
      return;
    }

    const drag: ArrangeDragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      isDragging: false,
      insertionIndex: null,
      captureEl: event.currentTarget,
      tracksSnapshot: tracks,
      selectedSnapshot: selected,
    };
    dragRef.current = drag;

    const onMove = (moveEvent: PointerEvent) => {
      const state = dragRef.current;
      if (state === null || state.pointerId !== moveEvent.pointerId) return;
      if (!state.isDragging) {
        if (
          Math.abs(moveEvent.clientY - state.startY) <=
          ARRANGE_DRAG_THRESHOLD_PX
        )
          return;
        state.isDragging = true;
        try {
          state.captureEl.setPointerCapture(state.pointerId);
        } catch (err) {
          void captureError({
            level: "warn",
            source: PLAYLIST_VIEW_MODULE,
            message: `arrange-capture-failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      const listTop = listRef.current?.getBoundingClientRect().top ?? 0;
      const drop = resolveArrangeDrop(
        state.tracksSnapshot,
        state.selectedSnapshot,
        moveEvent.clientY - listTop,
      );
      state.insertionIndex = drop?.insertionIndex ?? null;
      const indicatorY = drop?.indicatorY ?? null;
      // Light update: a pointermove inside the same boundary is a no-op
      // (no re-render per pixel, §21).
      setDragPreview((prev) =>
        prev.active && prev.indicatorY === indicatorY
          ? prev
          : { active: true, indicatorY },
      );
    };

    const onEnd = (endEvent: PointerEvent) => {
      const state = dragRef.current;
      if (state === null || state.pointerId !== endEvent.pointerId) return;
      detachDragListeners();
      dragRef.current = null;
      try {
        if (state.captureEl.hasPointerCapture(state.pointerId)) {
          state.captureEl.releasePointerCapture(state.pointerId);
        }
      } catch (err) {
        void captureError({
          level: "warn",
          source: PLAYLIST_VIEW_MODULE,
          message: `arrange-release-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      setDragPreview({ active: false, indicatorY: null });
      if (state.isDragging) {
        suppressRowClickRef.current = true;
        if (state.insertionIndex !== null) {
          commitArrangeDrop(state, state.insertionIndex);
        }
      }
    };

    dragHandlersRef.current = { move: onMove, end: onEnd };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const resetArrange = useCallback(() => {
    setArrangeMode(false);
  }, []);

  return {
    arrangeMode,
    dragPreview,
    listRef,
    suppressRowClickRef,
    enterArrangeMode,
    handleArrangeDone,
    handleArrangeCancel,
    handleRowPointerDown,
    resetArrange,
  };
}
