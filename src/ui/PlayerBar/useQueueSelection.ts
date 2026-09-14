import { useCallback, useMemo, useState } from "react";
import type { Track } from "../../types";
import { removeTracksFromQueue } from "../../store/queueOps";
import { usePlayerStore } from "../../store/playerStore";
import { sameTrack, trackKey } from "../../hooks/player/utils";
import type { QueueViewItem } from "./queueView";

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
 *
 * Select-all is WYSIWYG: it covers exactly the rows the panel currently
 * renders (`viewItems`, after search filtering and folder collapse), so a
 * bulk remove can never take out a queue entry the user could not see
 * checked. Selection itself still persists across view changes — toggling
 * only adds/removes the visible keys, hidden selections are left alone.
 */
export function useQueueSelection(
  playbackQueue: Track[],
  currentTrack: Track | null,
  viewItems: QueueViewItem[],
): QueueSelection {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Selection prune: when the queue OR the playing track changes under the
  // panel, drop selected ids that no longer exist and drop the entry that
  // just became current (auto-advance while selection mode is open: its
  // checkbox is hidden, so it must not linger in the count as a dead key).
  // Leave selection mode once no selectable (non-current) row remains —
  // adjusted during render so no setState runs inside an effect.
  const [lastQueue, setLastQueue] = useState(playbackQueue);
  const [lastCurrent, setLastCurrent] = useState(currentTrack);
  if (lastQueue !== playbackQueue || lastCurrent !== currentTrack) {
    setLastQueue(playbackQueue);
    setLastCurrent(currentTrack);
    if (selectionMode) {
      const validIds = new Set(playbackQueue.map(trackKey));
      const currentIds =
        currentTrack === null
          ? new Set<string>()
          : new Set(
              playbackQueue
                .filter((track) => sameTrack(track, currentTrack))
                .map(trackKey),
            );
      const nextSelected = new Set(
        [...selected].filter((id) => validIds.has(id) && !currentIds.has(id)),
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

  // Select-all scope = the track rows the panel currently renders (folder
  // rows hide their members, the search filter hides non-matches).
  const selectableItems = useMemo(() => {
    const tracks: Track[] = [];
    for (const item of viewItems) {
      if (item.kind !== "track") continue;
      if (currentTrack !== null && sameTrack(item.track, currentTrack)) {
        continue;
      }
      tracks.push(item.track);
    }
    return tracks;
  }, [viewItems, currentTrack]);
  const allSelected =
    selectableItems.length > 0 &&
    selectableItems.every((track) => selected.has(trackKey(track)));

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
    setSelected((prev) => {
      const next = new Set(prev);
      for (const track of selectableItems) {
        const key = trackKey(track);
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
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
