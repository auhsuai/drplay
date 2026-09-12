import { useCallback, useMemo, useState } from "react";
import type { Track } from "../../types";
import { removeTracksFromQueue } from "../../store/queueOps";
import { usePlayerStore } from "../../store/playerStore";
import { sameTrack } from "../../hooks/player/utils";

const trackKey = (track: Track): string => track.queueItemId ?? track.id;

export interface QueueSelection {
  selectionMode: boolean;
  selected: Set<string>;
  allSelected: boolean;
  toggleSelected: (key: string) => void;
  toggleSelectionMode: () => void;
  exitSelection: () => void;
  toggleSelectAll: () => void;
  removeSelected: () => void;
}

/**
 * Multi-select state for the queue panel. Selected ids are queueItemId-based
 * (falling back to the Drive id) so one exact queue entry is addressed even
 * when the same file appears twice. The playing track is never selectable.
 */
export function useQueueSelection(
  playbackQueue: Track[],
  currentTrack: Track | null,
): QueueSelection {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Selection prune: when the queue changes under the panel, drop selected
  // ids that no longer exist and leave selection mode once no selectable
  // (non-current) row remains — adjusted during render so no setState runs
  // inside an effect.
  const [lastQueue, setLastQueue] = useState(playbackQueue);
  if (lastQueue !== playbackQueue) {
    setLastQueue(playbackQueue);
    if (selectionMode) {
      const validIds = new Set(playbackQueue.map(trackKey));
      const nextSelected = new Set(
        [...selected].filter((id) => validIds.has(id)),
      );
      const hasSelectableRow = playbackQueue.some(
        (track) => currentTrack === null || !sameTrack(track, currentTrack),
      );
      if (!hasSelectableRow) {
        setSelectionMode(false);
        setSelected(new Set());
      } else if (nextSelected.size !== selected.size) {
        setSelected(nextSelected);
      }
    }
  }

  const selectableItems = useMemo(
    () =>
      playbackQueue.filter(
        (track) => currentTrack === null || !sameTrack(track, currentTrack),
      ),
    [playbackQueue, currentTrack],
  );
  const allSelected =
    selectableItems.length > 0 && selected.size >= selectableItems.length;

  const toggleSelected = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const exitSelection = () => {
    setSelectionMode(false);
    setSelected(new Set());
  };

  const toggleSelectionMode = () => {
    if (selectionMode) exitSelection();
    else setSelectionMode(true);
  };

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(selectableItems.map(trackKey)));
  };

  const removeSelected = () => {
    if (selected.size === 0) return;
    removeTracksFromQueue([...selected]);
    setSelected(new Set());
    // Read fresh state: a removed id may have been the last selectable row,
    // in which case selection mode has nothing left to operate on.
    const fresh = usePlayerStore.getState();
    const hasSelectableRow = fresh.playbackQueue.some(
      (track) =>
        fresh.currentTrack === null || !sameTrack(track, fresh.currentTrack),
    );
    if (!hasSelectableRow) setSelectionMode(false);
  };

  return {
    selectionMode,
    selected,
    allSelected,
    toggleSelected,
    toggleSelectionMode,
    exitSelection,
    toggleSelectAll,
    removeSelected,
  };
}
