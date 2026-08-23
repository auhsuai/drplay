import React from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { Music, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../../types";
import { IS_MOBILE } from "../../../utils/platform";
import { formatBytes } from "../../../utils/formatBytes";

interface TrackRowProps {
  virtualRow: VirtualItem;
  tracks: Track[];
  currentTrack?: Track | null | undefined;
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  onRemove: (e: React.MouseEvent, trackId: string) => Promise<void>;
}

// Body of PlaylistView's virtualized row map, extracted verbatim during
// Phase A — pure move. The F3 keyboard guard and the Task 6 mobile icon-box
// comment below are intentional; do not drop them.
export function TrackRow({
  virtualRow,
  tracks,
  currentTrack,
  onPlay,
  onRemove,
}: TrackRowProps) {
  const { t } = useTranslation();
  const track = tracks[virtualRow.index];
  if (track === undefined) return null;
  return (
    <div
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
          onPlay(track, tracks);
        }}
        onKeyDown={(e) => {
          // Only the row itself responds to Enter/Space; key
          // events from nested focusable controls (the remove
          // button) must reach their own default activation.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPlay(track, tracks);
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
          className={`w-8 text-center text-sm ${currentTrack?.id === track.id ? "text-brand-primary hidden group-hover:block" : "text-gray-400 group-hover:hidden"}`}
        >
          {currentTrack?.id === track.id ? (
            <Music className="w-4 h-4 mx-auto" />
          ) : (
            virtualRow.index + 1
          )}
        </div>
        <div
          className={`w-8 text-center items-center justify-center ${currentTrack?.id === track.id ? "flex group-hover:hidden" : "hidden group-hover:flex"}`}
        >
          <Play
            className={`w-4 h-4 ${currentTrack?.id === track.id ? "text-brand-primary" : "text-gray-900 dark:text-white"}`}
            fill="currentColor"
          />
        </div>

        {/* Task 6: the music icon box renders on mobile too
            (Task 12 kept the artist line off; the box is the
            track's placeholder — size still comes from the
            stored track, no extra call). Desktop untouched. */}
        <div
          className={`w-10 h-10 rounded-md flex items-center justify-center shrink-0 overflow-hidden ${currentTrack?.id === track.id ? "bg-brand-primary/10 text-brand-primary" : "bg-gray-200 dark:bg-gray-800"}`}
        >
          <Music
            className={`w-5 h-5 ${currentTrack?.id === track.id ? "text-brand-primary" : "text-gray-400"}`}
          />
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <h4
            className={`text-[15px] font-semibold truncate transition-colors leading-tight mb-0.5 ${currentTrack?.id === track.id ? "text-brand-primary" : "text-gray-900 dark:text-white group-hover:text-brand-primary"}`}
          >
            {track.title}
          </h4>
          {IS_MOBILE ? (
            track.size != null ? (
              <p className="text-[13px] text-gray-500 truncate leading-tight">
                {formatBytes(track.size)}
              </p>
            ) : null
          ) : (
            <p className="text-[13px] text-gray-500 truncate leading-tight">
              {t("unknown_artist")}
            </p>
          )}
        </div>

        <button
          onClick={(e) => {
            void onRemove(e, track.id);
          }}
          className="opacity-0 group-hover:opacity-100 p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-all text-gray-400 hover:text-red-500"
          title={t("remove_from_playlist")}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
