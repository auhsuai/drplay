import React, { useEffect, useState, useRef } from "react";
import { Play, Heart, Music } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Track } from "../../App";
import { getFavorites, removeFavorite } from "../../utils/favorites";
import { showErrorToast } from "../../utils/simpleToast";
import { MoreMenu } from "../components/MoreMenu";
import { prefetchVisibleTracks } from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";

const LIKED_SONGS_MODULE = "LikedSongs";

interface LikedSongsProps {
  onPlay: (track: Track, context: Track[], startIndex?: number) => void;
  token: string | null;
  currentTrack?: Track | null;
}

export function LikedSongs({ onPlay, currentTrack }: LikedSongsProps) {
  const { t } = useTranslation();
  const [favorites, setFavorites] = useState<Track[]>([]);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    loadFavorites().catch(
      (err: unknown) =>
        void captureError({
          level: "error",
          source: LIKED_SONGS_MODULE,
          message: `failed-to-load-favorites: ${err instanceof Error ? err.message : String(err)}`,
        }),
    );

    const handleUpdate = () => {
      void loadFavorites().catch(
        (err: unknown) =>
          void captureError({
            level: "error",
            source: LIKED_SONGS_MODULE,
            message: `failed-to-load-favorites: ${err instanceof Error ? err.message : String(err)}`,
          }),
      );
    };
    window.addEventListener("favorites-updated", handleUpdate);
    window.addEventListener("user-changed", handleUpdate);
    return () => {
      window.removeEventListener("favorites-updated", handleUpdate);
      window.removeEventListener("user-changed", handleUpdate);
    };
  }, []);

  const loadFavorites = async () => {
    try {
      const favs = await getFavorites();
      setFavorites(favs);
    } catch (e) {
      void captureError({
        level: "error",
        source: LIKED_SONGS_MODULE,
        message: `failed-to-load-favorites: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  useEffect(() => {
    if (favorites.length > 0) prefetchVisibleTracks(favorites);
  }, [favorites]);

  // eslint-disable-next-line react-hooks/incompatible-library -- the react-hooks compiler cannot analyze @tanstack/react-virtual's internals; the options object is a plain data bag and the hook result is used normally below.
  const rowVirtualizer = useVirtualizer({
    count: favorites.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 3,
  });

  const handleUnlike = async (e: React.MouseEvent, trackId: string) => {
    e.stopPropagation();
    try {
      await removeFavorite(trackId);
    } catch (e) {
      showErrorToast(t("liked_songs.remove_failed"));
      void captureError({
        level: "error",
        source: LIKED_SONGS_MODULE,
        message: `remove-favorite-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <main
      ref={scrollRef}
      className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto flex flex-col relative transition-colors duration-300"
    >
      {/* Header Gradient */}
      <div className="h-64 bg-gradient-to-b from-[#4285F4] to-white dark:to-[#121212] flex items-end p-8 flex-shrink-0">
        <div className="flex items-end gap-6">
          <div className="w-48 h-48 bg-gradient-to-br from-[#4285F4] to-[#66a3ff] shadow-2xl flex items-center justify-center text-white rounded-md">
            <Heart className="w-20 h-20" fill="currentColor" />
          </div>
          <div className="text-white dark:text-gray-100 mb-2">
            <p className="text-sm font-medium uppercase tracking-wider mb-2">
              {t("playlist_name")}
            </p>
            <h1 className="text-6xl font-bold mb-4 tracking-tight">
              {t("liked_songs.title")}
            </h1>
            <p className="text-sm font-medium opacity-80">
              {t("song", { count: favorites.length })}
            </p>
          </div>
        </div>
      </div>

      {/* Action Bar */}
      <div className="px-8 py-6 flex-shrink-0">
        <button
          onClick={() => {
            if (favorites.length > 0) {
              const first = favorites[0];
              if (first === undefined) return;
              onPlay(first, favorites, 0);
            }
          }}
          className="w-14 h-14 bg-[#4285F4] hover:bg-blue-600 rounded-full flex items-center justify-center text-white shadow-lg transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
          disabled={favorites.length === 0}
        >
          <Play className="w-6 h-6 ml-1" fill="currentColor" />
        </button>
      </div>

      {/* Track List */}
      <div className="px-8 pb-24 flex-1 min-h-0">
        {favorites.length === 0 ? (
          <div className="text-gray-500 dark:text-gray-400 text-center py-20">
            <Music className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <h3 className="text-xl font-medium mb-2">
              {t("liked_songs.empty_title")}
            </h3>
            <p className="text-sm">{t("liked_songs.empty_subtitle")}</p>
          </div>
        ) : (
          <div className="w-full">
            <div className="flex text-gray-500 text-[11px] pb-2 mb-2 px-2 uppercase tracking-widest font-bold">
              <div className="w-12 text-center">#</div>
              <div className="flex-1">{t("title")}</div>
              <div className="w-12"></div>
            </div>

            <div
              className="flex flex-col relative w-full"
              style={{
                height: `${String(rowVirtualizer.getTotalSize())}px`,
                contain: "strict",
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const track = favorites[virtualRow.index];
                if (track === undefined) return null;
                return (
                  <div
                    key={virtualRow.key}
                    style={{
                      position: "absolute",
                      left: 0,
                      width: "100%",
                      height: `${String(virtualRow.size)}px`,
                      transform: `translateY(${String(virtualRow.start)}px)`,
                    }}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        onPlay(track, favorites, virtualRow.index);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onPlay(track, favorites, virtualRow.index);
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        window.dispatchEvent(
                          new CustomEvent("locate-file", {
                            detail: {
                              fileId: track.id,
                              parentId: track.parentId,
                              parentName: track.parentName,
                            },
                          }),
                        );
                      }}
                      className={`flex items-center gap-4 p-2 rounded-lg group cursor-pointer transition-all active:scale-[0.99] ${
                        currentTrack?.id === track.id
                          ? "bg-gray-100 dark:bg-[#2A2A2A]"
                          : "hover:bg-gray-100 dark:hover:bg-[#2A2A2A]"
                      }`}
                    >
                      <div
                        className={`w-12 text-center text-sm ${currentTrack?.id === track.id ? "text-[#4285F4] hidden group-hover:block" : "text-gray-400 group-hover:hidden"}`}
                      >
                        {currentTrack?.id === track.id ? (
                          <Music className="w-4 h-4 mx-auto" />
                        ) : (
                          virtualRow.index + 1
                        )}
                      </div>
                      <div
                        className={`w-12 text-center items-center justify-center ${currentTrack?.id === track.id ? "flex group-hover:hidden" : "hidden group-hover:flex"}`}
                      >
                        <Play
                          className={`w-4 h-4 ${currentTrack?.id === track.id ? "text-[#4285F4]" : "text-gray-900 dark:text-white"}`}
                          fill="currentColor"
                        />
                      </div>

                      <div
                        className={`w-10 h-10 rounded-md flex items-center justify-center shrink-0 overflow-hidden ${currentTrack?.id === track.id ? "bg-[#4285F4]/10 text-[#4285F4]" : "bg-gradient-to-br from-[#4285F4]/10 to-[#34A853]/10 text-[#4285F4]"}`}
                      >
                        <Music className="w-5 h-5 opacity-80" />
                      </div>

                      <div className="flex-1 min-w-0 flex flex-col justify-center">
                        <h4
                          className={`text-[15px] font-semibold truncate transition-colors leading-tight mb-0.5 ${currentTrack?.id === track.id ? "text-[#4285F4]" : "text-gray-900 dark:text-white group-hover:text-[#4285F4]"}`}
                        >
                          {track.title}
                        </h4>
                        <p className="text-[13px] text-gray-500 truncate leading-tight">
                          {track.artist || t("unknown_artist")}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => {
                            void handleUnlike(e, track.id);
                          }}
                          className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-all text-[#4285F4] hover:scale-110"
                          title={t("menu.remove_from_liked")}
                        >
                          <Heart className="w-4 h-4" fill="currentColor" />
                        </button>
                        <MoreMenu track={track} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
