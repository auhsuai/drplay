import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../types";
import {
  removeTrackFromPlaylist,
  removeTracksFromPlaylist,
} from "../../utils/playlists";
import { captureError } from "../../utils/errorLog";
import { showErrorToast } from "../../utils/simpleToast";
import { PLAYLIST_VIEW_MODULE } from "./usePlaylistData";

interface UsePlaylistSelectionOptions {
  playlistId: string;
  tracks: Track[];
  // Clears arrange mode; injected so this hook never has to know about the
  // arrange hook (and the hook order stays linear).
  resetArrange: () => void;
}

interface UsePlaylistSelectionResult {
  selectionMode: boolean;
  selected: Set<string>;
  allSelected: boolean;
  enterSelection: (trackId?: string) => void;
  exitSelection: () => void;
  toggleSelected: (trackId: string) => void;
  toggleSelectAll: () => void;
  handleBulkRemove: () => Promise<void>;
  removeTrackById: (trackId: string) => Promise<void>;
}

export function usePlaylistSelection({
  playlistId,
  tracks,
  resetArrange,
}: UsePlaylistSelectionOptions): UsePlaylistSelectionResult {
  const { t } = useTranslation();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // The playlist utils never reject (they log + toast internally), but keep
  // the second line of defense so a programming error can never surface as an
  // unhandled rejection from a click handler. Returns null on failure.
  const runRemoval = async <T>(
    removal: () => Promise<T>,
    failureLog: string,
  ): Promise<T | null> => {
    try {
      return await removal();
    } catch (err) {
      void captureError({
        level: "error",
        source: PLAYLIST_VIEW_MODULE,
        message: `${failureLog}: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("playlist.remove_error"));
      return null;
    }
  };

  const removeTrackById = async (trackId: string): Promise<void> => {
    await runRemoval(
      () => removeTrackFromPlaylist(playlistId, trackId),
      "remove-track-failed",
    );
  };

  // Row menu passes the clicked track (enter with that row selected); the
  // header Select button enters with an empty selection (0 selected state).
  const enterSelection = (trackId?: string) => {
    setSelectionMode(true);
    setSelected(trackId === undefined ? new Set() : new Set([trackId]));
  };

  const exitSelection = () => {
    setSelectionMode(false);
    resetArrange();
    setSelected(new Set());
  };

  const toggleSelected = (trackId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  };

  const allSelected =
    tracks.length > 0 && tracks.every((track) => selected.has(track.id));

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const track of tracks) {
        if (allSelected) next.delete(track.id);
        else next.add(track.id);
      }
      return next;
    });
  };

  const handleBulkRemove = async () => {
    if (selected.size === 0) return;
    const ids = [...selected];
    // Snapshot before the await: the playlist may reload while the write is
    // in flight, and the exit decision belongs to the click's own list.
    const removedAll = tracks.every((track) => selected.has(track.id));
    const ok = await runRemoval(
      () => removeTracksFromPlaylist(playlistId, ids),
      "remove-tracks-failed",
    );
    // Failure keeps the selection (and selection mode) so the user can retry;
    // the data layer already surfaced the error toast.
    if (ok !== true) return;
    if (removedAll) exitSelection();
    else setSelected(new Set());
  };

  return {
    selectionMode,
    selected,
    allSelected,
    enterSelection,
    exitSelection,
    toggleSelected,
    toggleSelectAll,
    handleBulkRemove,
    removeTrackById,
  };
}
