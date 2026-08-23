import React, { useState, useEffect, useRef, useCallback } from "react";
import type { Track } from "../../types";
import { Music, Play } from "lucide-react";
import type { Playlist } from "../../utils/playlists";
import {
  getPlaylistById,
  removeTrackFromPlaylist,
  deletePlaylist,
} from "../../utils/playlists";
import { ImageCropperModal } from "../components/ImageCropperModal";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { showErrorToast } from "../../utils/simpleToast";
import { prefetchVisibleTracks } from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";
import { PlaylistHeader } from "./components/PlaylistHeader";
import { TrackRow } from "./components/TrackRow";
import { usePlaylistCover } from "./hooks/usePlaylistCover";

const PLAYLIST_VIEW_MODULE = "PlaylistView";

interface PlaylistViewProps {
  playlistId: string;
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  onDelete: () => void;
  currentTrack?: Track | null;
}

export function PlaylistView({
  playlistId,
  onPlay,
  onDelete,
  currentTrack,
}: PlaylistViewProps) {
  const { t } = useTranslation();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);

  // Cover/cropper state + handlers live in usePlaylistCover. Its internal
  // useHardwareBack registration must run unconditionally, so this call sits
  // ABOVE the early `if (!playlist) return null` — keeping hook order stable
  // across the null/non-null re-renders (rationale continues in the hook).
  const {
    fileInputRef,
    selectedImage,
    isCropperOpen,
    setIsCropperOpen,
    setSelectedImage,
    handleFileChange,
    handleSaveCover,
  } = usePlaylistCover({ playlistId, onPlaylistUpdated: setPlaylist });

  const scrollRef = useRef<HTMLElement>(null);

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
    }
  }, [playlistId, t]);

  useEffect(() => {
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
  // minimal fake from the mount-time playlistId. The router remounts this
  // view for every playlist_ tab via key (TabContentRouter), so playlistId
  // never changes under a mounted view.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once debug listener; a playlist-to-playlist switch remounts the view (router key), which re-runs this effect naturally, and the real load effect overwrites any fake on that switch anyway.
  }, []);

  const tracks = playlist?.tracks ?? [];

  // eslint-disable-next-line react-hooks/incompatible-library -- the react-hooks compiler cannot analyze @tanstack/react-virtual's internals; the options object is a plain data bag and the hook result is used normally below.
  const rowVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 3,
  });

  if (!playlist) return null;

  const handleRemove = async (e: React.MouseEvent, trackId: string) => {
    e.stopPropagation();
    try {
      await removeTrackFromPlaylist(playlistId, trackId);
    } catch (err) {
      void captureError({
        level: "error",
        source: PLAYLIST_VIEW_MODULE,
        message: `remove-track-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("playlist.remove_error"));
    }
  };

  const handleDelete = async () => {
    if (window.confirm(t("confirm_delete_playlist"))) {
      try {
        await deletePlaylist(playlistId);
        onDelete(); // Triggers tab change in App
      } catch (err) {
        void captureError({
          level: "error",
          source: PLAYLIST_VIEW_MODULE,
          message: `delete-playlist-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        showErrorToast(t("playlist.delete_error"));
      }
    }
  };

  return (
    <main
      ref={scrollRef}
      className="flex-1 overflow-y-auto bg-white dark:bg-[#121212] flex flex-col relative transition-colors duration-300"
    >
      <PlaylistHeader
        playlist={playlist}
        fileInputRef={fileInputRef}
        handleFileChange={handleFileChange}
        handleDelete={handleDelete}
      />

      <div className="px-8 pb-24 flex-1 min-h-0">
        {tracks.length > 0 && (
          <button
            onClick={() => {
              const first = tracks[0];
              if (first === undefined) return;
              onPlay(first, tracks);
            }}
            className="w-14 h-14 bg-brand-primary rounded-full flex items-center justify-center text-white hover:scale-105 hover:bg-blue-600 transition-all shadow-lg mb-8 flex-shrink-0"
          >
            <Play className="w-7 h-7 fill-current ml-1" />
          </button>
        )}

        {tracks.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <Music className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <h3 className="text-xl font-medium text-gray-700 dark:text-gray-300">
              {t("playlist.empty_state_title")}
            </h3>
            <p className="mt-2 text-sm">{t("playlist.empty_state_subtitle")}</p>
          </div>
        ) : (
          <div
            className="flex flex-col relative w-full"
            style={{
              height: `${String(rowVirtualizer.getTotalSize())}px`,
              contain: "strict",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => (
              <TrackRow
                key={virtualRow.key}
                virtualRow={virtualRow}
                tracks={tracks}
                currentTrack={currentTrack}
                onPlay={onPlay}
                onRemove={handleRemove}
              />
            ))}
          </div>
        )}
      </div>

      {isCropperOpen && selectedImage && (
        <ImageCropperModal
          imageSrc={selectedImage}
          onClose={() => {
            setIsCropperOpen(false);
            setSelectedImage(null);
          }}
          onSave={(img) => {
            void handleSaveCover(img);
          }}
        />
      )}
    </main>
  );
}
