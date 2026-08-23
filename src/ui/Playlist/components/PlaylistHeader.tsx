import React from "react";
import { Camera, Music, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Playlist } from "../../../utils/playlists";

interface PlaylistHeaderProps {
  playlist: Playlist;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleDelete: () => Promise<void>;
}

// Header block of PlaylistView (cover art + picker overlay + meta row +
// delete action), extracted verbatim during Phase A — pure move.
export function PlaylistHeader({
  playlist,
  fileInputRef,
  handleFileChange,
  handleDelete,
}: PlaylistHeaderProps) {
  const { t } = useTranslation();
  return (
    <>
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
            <button
              onClick={() => {
                void handleDelete();
              }}
              className="text-red-500 hover:text-red-600 flex items-center gap-1 transition-colors"
            >
              <Trash2 className="w-4 h-4" /> {t("delete")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
