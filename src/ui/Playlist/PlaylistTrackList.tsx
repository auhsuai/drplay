import { useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { Music, Play, GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../types";
import { MoreMenu } from "../components/MoreMenu";
import { QueueRowCheckbox } from "../PlayerBar/QueueRow";
import type { ArrangeDragPreview } from "./usePlaylistArrange";

interface PlaylistTrackListProps {
  tracks: Track[];
  virtualItems: VirtualItem[];
  totalSize: number;
  listRef: RefObject<HTMLDivElement | null>;
  arrangeMode: boolean;
  dragPreview: ArrangeDragPreview;
  suppressRowClickRef: RefObject<boolean>;
  selectionMode: boolean;
  selected: Set<string>;
  currentTrack?: Track | null | undefined;
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  toggleSelected: (trackId: string) => void;
  handleRowPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    trackId: string,
  ) => void;
  removeTrackById: (trackId: string) => Promise<void>;
  enterSelection: (trackId?: string) => void;
}

export function PlaylistTrackList({
  tracks,
  virtualItems,
  totalSize,
  listRef,
  arrangeMode,
  dragPreview,
  suppressRowClickRef,
  selectionMode,
  selected,
  currentTrack,
  onPlay,
  toggleSelected,
  handleRowPointerDown,
  removeTrackById,
  enterSelection,
}: PlaylistTrackListProps) {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{
    index: number;
    x: number;
    y: number;
  } | null>(null);

  return (
    <div
      ref={listRef}
      data-testid="playlist-track-list"
      className={`flex flex-col relative w-full ${arrangeMode ? "select-none" : ""}`}
      style={{
        height: `${String(totalSize)}px`,
        contain: "strict",
      }}
    >
      {arrangeMode && dragPreview.indicatorY !== null && (
        <div
          data-testid="playlist-drop-indicator"
          aria-hidden="true"
          className="absolute left-0 right-0 h-0.5 bg-brand-primary z-20 pointer-events-none rounded-full"
          style={{ top: `${String(dragPreview.indicatorY)}px` }}
        />
      )}
      {virtualItems.map((virtualRow) => {
        const track = tracks[virtualRow.index];
        if (track === undefined) return null;
        const isContextTarget =
          contextMenu !== null && contextMenu.index === virtualRow.index;
        const isSelected = selected.has(track.id);
        const isDragGhost = dragPreview.active && isSelected;
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
                // A completed drag must not fall through to the click.
                if (suppressRowClickRef.current) {
                  suppressRowClickRef.current = false;
                  return;
                }
                if (selectionMode) toggleSelected(track.id);
                else onPlay(track, tracks);
              }}
              onPointerDown={(e) => {
                handleRowPointerDown(e, track.id);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                // Nested controls (checkbox, ⋯ trigger) own their keys.
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                if (selectionMode) toggleSelected(track.id);
                else onPlay(track, tracks);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                // Selection mode replaces per-row actions entirely.
                if (selectionMode) return;
                setContextMenu({
                  index: virtualRow.index,
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
              className={`flex items-center gap-4 p-2 rounded-lg group transition-all active:scale-[0.99] ${
                arrangeMode && isSelected
                  ? "cursor-grab touch-none"
                  : "cursor-pointer"
              } ${isDragGhost ? "opacity-50" : ""}`}
            >
              <div
                className={`w-8 text-center text-sm ${selectionMode ? "flex items-center justify-center" : currentTrack?.id === track.id ? "text-brand-text hidden group-hover:block" : "text-gray-400 group-hover:hidden"}`}
              >
                {selectionMode ? (
                  <QueueRowCheckbox
                    checked={selected.has(track.id)}
                    label={track.title}
                    onToggle={() => {
                      toggleSelected(track.id);
                    }}
                  />
                ) : currentTrack?.id === track.id ? (
                  <Music className="w-4 h-4 mx-auto" />
                ) : (
                  virtualRow.index + 1
                )}
              </div>
              <div
                className={`w-8 text-center items-center justify-center ${selectionMode ? "flex" : currentTrack?.id === track.id ? "flex group-hover:hidden" : "hidden group-hover:flex"}`}
              >
                {!selectionMode && (
                  <Play
                    className={`w-4 h-4 ${currentTrack?.id === track.id ? "text-brand-text" : "text-gray-900 dark:text-white"}`}
                    fill="currentColor"
                  />
                )}
                {/* Arrange mode: grip marks the draggable (selected)
                    group items; non-selected keep the slot empty so the
                    row layout never shifts (§7.2). */}
                {arrangeMode && isSelected && (
                  <GripVertical
                    aria-hidden="true"
                    className="w-4 h-4 text-gray-400 dark:text-gray-500"
                  />
                )}
              </div>

              <div
                className={`w-10 h-10 rounded-md flex items-center justify-center shrink-0 overflow-hidden ${currentTrack?.id === track.id ? "bg-brand-primary/10 text-brand-text" : "bg-gray-200 dark:bg-gray-800"}`}
              >
                <Music
                  className={`w-5 h-5 ${currentTrack?.id === track.id ? "text-brand-text" : "text-gray-400"}`}
                />
              </div>

              <div className="flex-1 min-w-0 flex flex-col justify-center">
                <h4
                  className={`text-[15px] font-semibold truncate transition-colors leading-tight mb-0.5 ${currentTrack?.id === track.id ? "text-brand-text" : "text-gray-900 dark:text-white group-hover:text-brand-text"}`}
                >
                  {track.title}
                </h4>
                <p className="text-[13px] text-gray-500 truncate leading-tight">
                  {track.artist || t("unknown_artist")}
                </p>
              </div>

              {!selectionMode && (
                <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <MoreMenu
                    variant="playlist"
                    track={track}
                    forceOpen={isContextTarget}
                    anchorPoint={
                      isContextTarget
                        ? { x: contextMenu.x, y: contextMenu.y }
                        : null
                    }
                    onClose={() => {
                      setContextMenu(null);
                    }}
                    onRemoveFromPlaylist={() => {
                      void removeTrackById(track.id);
                    }}
                    onSelectMultiple={() => {
                      enterSelection(track.id);
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
