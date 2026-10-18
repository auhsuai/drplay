import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { Playlist } from "../../utils/playlists";
import { getPlaylistById } from "../../utils/playlists";
import { prefetchVisibleTracks } from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";
import { showErrorToast } from "../../utils/simpleToast";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

export const PLAYLIST_VIEW_MODULE = "PlaylistView";

interface UsePlaylistDataResult {
  playlist: Playlist | null;
  setPlaylist: Dispatch<SetStateAction<Playlist | null>>;
  isLoadSettled: boolean;
}

export function usePlaylistData(playlistId: string): UsePlaylistDataResult {
  const { t } = useTranslation();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [isLoadSettled, setIsLoadSettled] = useState(false);

  const loadPlaylist = useCallback(async () => {
    try {
      const data = await getPlaylistById(playlistId);
      setPlaylist(data);
    } catch (e) {
      void captureError({
        level: "error",
        source: PLAYLIST_VIEW_MODULE,
        message: `failed-to-load-playlist: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("playlist.load_error"));
    } finally {
      // Distinguishes "still loading" (render nothing) from "settled without a
      // playlist" (playlist missing/deleted or load failed → message).
      setIsLoadSettled(true);
    }
  }, [playlistId, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pure move of the pre-existing load effect: both setState calls run after the awaited fetch inside loadPlaylist, never synchronously; the compiler rule cannot see through the async callback.
    loadPlaylist().catch(
      (err: unknown) =>
        void captureError({
          level: "error",
          source: PLAYLIST_VIEW_MODULE,
          message: `failed-to-load-playlist: ${err instanceof Error ? err.message : String(err)}`,
        }),
    );
    const handlePlaylistsUpdated = () => {
      void loadPlaylist();
    };
    const handleUserChanged = () => {
      void loadPlaylist();
    };
    window.addEventListener("playlists-updated", handlePlaylistsUpdated);
    window.addEventListener("user-changed", handleUserChanged);
    return () => {
      window.removeEventListener("playlists-updated", handlePlaylistsUpdated);
      window.removeEventListener("user-changed", handleUserChanged);
    };
  }, [playlistId, loadPlaylist]);

  useEffect(() => {
    if (!playlist) return;
    if (playlist.tracks.length > 0) prefetchVisibleTracks(playlist.tracks);
  }, [playlist]);

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Empty states"): forces the
  // empty state by swapping in a valid Playlist with no tracks. Keeps the
  // real playlist's identity when it is already loaded; otherwise builds a
  // minimal fake from the mount-time playlistId (the view only mounts while a
  // playlist_* tab is active, so playlistId is stable for the mounted view).
  // onDebugEvent no-ops in production builds; the listener never runs there.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.PLAYLIST_EMPTY, () => {
      setPlaylist((prev) =>
        prev
          ? { ...prev, tracks: [] }
          : {
              id: playlistId,
              userEmail: "",
              name: playlistId,
              createdAt: 0,
              tracks: [],
            },
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once debug listener; re-subscribing on playlistId change would only matter after a direct playlist-to-playlist switch (no remount), and the real load effect overwrites the fake on that switch anyway.
  }, []);

  return { playlist, setPlaylist, isLoadSettled };
}
