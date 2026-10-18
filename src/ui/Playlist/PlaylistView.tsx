import React, { useState, useEffect, useRef, useCallback } from "react";
import type { Track } from "../../types";
import { Music, Play, Camera, SquareCheckBig } from "lucide-react";
import { updatePlaylist } from "../../utils/playlists";
import { ImageCropperModal } from "../components/ImageCropperModal";
import { QueueSelectionToolbar } from "../PlayerBar/QueueSelectionToolbar";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { PLAYLIST_VIEW_MODULE, usePlaylistData } from "./usePlaylistData";
import { usePlaylistSelection } from "./usePlaylistSelection";
import { usePlaylistArrange } from "./usePlaylistArrange";
import { PlaylistTrackList } from "./PlaylistTrackList";

interface PlaylistViewProps {
  playlistId: string;
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  currentTrack?: Track | null;
}

export function PlaylistView({
  playlistId,
  onPlay,
  currentTrack,
}: PlaylistViewProps) {
  const { t } = useTranslation();
  const { playlist, setPlaylist, isLoadSettled } = usePlaylistData(playlistId);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isCropperOpen, setIsCropperOpen] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const tracks = playlist?.tracks ?? [];

  // Selection resets arrange mode on exit; the ref defers to the arrange hook
  // below without creating a hook-order cycle between the two.
  const resetArrangeRef = useRef<() => void>(() => {});
  const resetArrange = useCallback(() => {
    resetArrangeRef.current();
  }, []);

  const {
    selectionMode,
    selected,
    allSelected,
    enterSelection,
    exitSelection,
    toggleSelected,
    toggleSelectAll,
    handleBulkRemove,
    removeTrackById,
  } = usePlaylistSelection({
    playlistId,
    tracks,
    resetArrange,
  });

  const {
    arrangeMode,
    dragPreview,
    listRef,
    suppressRowClickRef,
    enterArrangeMode,
    handleArrangeDone,
    handleArrangeCancel,
    handleRowPointerDown,
    resetArrange: resetArrangeMode,
  } = usePlaylistArrange({
    playlistId,
    tracks,
    selected,
    setPlaylist,
    exitSelection,
  });

  useEffect(() => {
    resetArrangeRef.current = resetArrangeMode;
  }, [resetArrangeMode]);

  // eslint-disable-next-line react-hooks/incompatible-library -- the react-hooks compiler cannot analyze @tanstack/react-virtual's internals; the options object is a plain data bag and the hook result is used normally below.
  const rowVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 3,
  });

  if (!playlist) {
    if (!isLoadSettled) return null;
    return (
      <main className="flex-1 bg-white dark:bg-[#121212] flex items-center justify-center transition-colors duration-300">
        <div className="text-center text-gray-500 dark:text-gray-400">
          <Music className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <h3 className="text-xl font-medium text-gray-700 dark:text-gray-300">
            {t("playlist.load_error")}
          </h3>
        </div>
      </main>
    );
  }

  const MAX_COVER_BYTES = 5 * 1024 * 1024;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showErrorToast(t("playlist.cover_invalid_type"));
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      showErrorToast(t("playlist.cover_too_large"));
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      setSelectedImage(event.target?.result as string);
      setIsCropperOpen(true);
    };
    reader.onerror = () => {
      void captureError({
        level: "error",
        source: PLAYLIST_VIEW_MODULE,
        message: `read-cover-failed: name=${file.name}, size=${String(file.size)}`,
      });
      showErrorToast(t("playlist.cover_read_error"));
    };
    reader.readAsDataURL(file);
  };

  const handleSaveCover = async (base64Img: string) => {
    setIsCropperOpen(false);
    setSelectedImage(null);
    try {
      const updated = await updatePlaylist(playlistId, {
        coverImage: base64Img,
      });
      if (updated) {
        setPlaylist(updated);
      }
    } catch (err) {
      void captureError({
        level: "error",
        source: PLAYLIST_VIEW_MODULE,
        message: `update-cover-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("playlist.cover_save_error"));
    }
  };

  return (
    <main
      ref={scrollRef}
      className="flex-1 overflow-y-auto bg-white dark:bg-[#121212] flex flex-col relative transition-colors duration-300"
    >
      {/* Header Gradient */}
      <div className="absolute top-0 left-0 right-0 h-80 bg-gradient-to-b from-brand-primary/40 to-transparent pointer-events-none opacity-50 dark:opacity-20" />

      <div className="relative z-10 px-8 pt-20 pb-8 flex items-end gap-6 flex-shrink-0">
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className="relative w-48 h-48 rounded-xl shadow-2xl shrink-0 group overflow-hidden cursor-pointer"
        >
          {playlist.coverImage ? (
            <img
              src={playlist.coverImage}
              className="w-full h-full object-cover"
              alt={playlist.name}
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-brand-primary to-[#34A853] flex items-center justify-center">
              <Music className="w-20 h-20 text-white opacity-80" />
            </div>
          )}

          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity duration-200">
            <Camera className="w-8 h-8 text-white mb-2" />
            <span className="text-white text-sm font-medium">
              {t("playlist.change_cover")}
            </span>
          </div>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/*"
            className="hidden"
          />
        </div>
        <div className="flex-1 pb-2">
          <span className="text-sm font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">
            {t("playlist_name")}
          </span>
          <h1
            className="text-5xl font-black mt-2 mb-6 text-gray-900 dark:text-white truncate"
            title={playlist.name}
          >
            {playlist.name}
          </h1>
          <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-300 font-medium">
            <span>{t("song", { count: playlist.tracks.length })}</span>
          </div>
        </div>
      </div>

      <div className="px-8 pb-24 flex-1 min-h-0">
        {tracks.length > 0 && (
          <div className="mb-8 flex-shrink-0">
            {selectionMode ? (
              arrangeMode ? (
                <div
                  data-testid="playlist-arrange-toolbar"
                  className="flex min-w-0 flex-col gap-2 animate-in fade-in duration-300"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={handleArrangeCancel}
                      className="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95"
                    >
                      {t("playlist.arrange_cancel")}
                    </button>
                    <span className="min-w-0 truncate px-2 py-1 font-semibold text-lg text-gray-900 dark:text-white">
                      {t("playlist.arrange_mode")}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {t("playlist.arrange_hint")}
                    </span>
                    <button
                      type="button"
                      onClick={handleArrangeDone}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-brand-primary hover:bg-blue-600 rounded-lg transition-colors shadow-sm active:scale-95"
                    >
                      {t("playlist.arrange_done")}
                    </button>
                  </div>
                </div>
              ) : (
                <QueueSelectionToolbar
                  selectedCount={selected.size}
                  allSelected={allSelected}
                  onToggleSelectAll={toggleSelectAll}
                  onRemove={() => {
                    void handleBulkRemove();
                  }}
                  onExit={exitSelection}
                  removeLabel={t("remove_from_playlist")}
                  onArrange={enterArrangeMode}
                  arrangeLabel={t("playlist.arrange")}
                />
              )
            ) : (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    const first = tracks[0];
                    if (first === undefined) return;
                    onPlay(first, tracks);
                  }}
                  className="w-14 h-14 bg-brand-primary rounded-full flex items-center justify-center text-white hover:scale-105 hover:bg-blue-600 transition-all shadow-lg"
                >
                  <Play className="w-7 h-7 fill-current ml-1" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    enterSelection();
                  }}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95"
                >
                  <SquareCheckBig className="w-4 h-4" />
                  <span>{t("playlist.select")}</span>
                </button>
              </div>
            )}
          </div>
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
          <PlaylistTrackList
            tracks={tracks}
            virtualItems={rowVirtualizer.getVirtualItems()}
            totalSize={rowVirtualizer.getTotalSize()}
            listRef={listRef}
            arrangeMode={arrangeMode}
            dragPreview={dragPreview}
            suppressRowClickRef={suppressRowClickRef}
            selectionMode={selectionMode}
            selected={selected}
            currentTrack={currentTrack}
            onPlay={onPlay}
            toggleSelected={toggleSelected}
            handleRowPointerDown={handleRowPointerDown}
            removeTrackById={removeTrackById}
            enterSelection={enterSelection}
          />
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
