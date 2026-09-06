import React, { useState } from "react";
import { Folder, Music, Square, SquareCheckBig } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../../types";
import type { DriveItem } from "../../../types";
import { formatBytes } from "../../../utils/formatBytes";
import { MoreMenu } from "../../components/MoreMenu";
import type { MoreMenuVariant } from "../../components/MoreMenu";
import { formatDuration } from "../utils/formatDuration";
import {
  useHighlightFlash,
  ACCENT_CARD_TINT,
  ACCENT_CARD_TINT_HOVER,
} from "../hooks/useHighlightFlash";
import { useSongCardMetadata } from "../hooks/useSongCardMetadata";

interface SongCardProps {
  item: DriveItem;
  onPlay: (track: Track) => void;
  onOpenFolder: (id: string, name: string) => void;
  token?: string | null;
  currentFolderId: string;
  currentFolderName: string;
  isHighlighted?: boolean;
  highlightTrigger?: number | undefined;
  folderHistory: { id: string; name: string }[];
  onRefresh: () => void;
  onRemoveItem?: ((id: string) => void) | undefined;
  isPlaying?: boolean;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelection?: (id: string) => void;
  onEnableSelectionMode?: (id: string) => void;
  hideMenu?: boolean;
  menuVariant?: MoreMenuVariant;
  onBulkMoveClick?: (() => void) | undefined;
  onBulkDeleteClick?: (() => void) | undefined;
}

// Card state precedence mirrors the old nested ternary: flash overrides
// everything (transient 400ms cue), then bulk-selection accent, then
// now-playing, then the idle hover palette.
const CARD_STATE_CLASSES = {
  flash: "bg-white dark:bg-[#383a40] shadow-lg shadow-black/5",
  selected: `${ACCENT_CARD_TINT} ${ACCENT_CARD_TINT_HOVER}`,
  playing: "bg-gray-100 dark:bg-[#2a2b2f] shadow-sm",
  idle: "bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f]",
} as const;

function cardStateClass(
  isFlashOn: boolean,
  isSelected: boolean | undefined,
  isPlaying: boolean | undefined,
): string {
  if (isFlashOn) return CARD_STATE_CLASSES.flash;
  if (isSelected) return CARD_STATE_CLASSES.selected;
  if (isPlaying) return CARD_STATE_CLASSES.playing;
  return CARD_STATE_CLASSES.idle;
}

export const SongCard = React.memo(
  function SongCard({
    item,
    onPlay,
    onOpenFolder,
    token,
    currentFolderId,
    currentFolderName,
    isHighlighted,
    highlightTrigger,
    folderHistory,
    onRefresh,
    onRemoveItem,
    isPlaying,
    isSelectionMode,
    isSelected,
    onToggleSelection,
    onEnableSelectionMode,
    hideMenu,
    menuVariant,
    onBulkMoveClick,
    onBulkDeleteClick,
  }: SongCardProps) {
    const { t } = useTranslation();
    const cardRef = React.useRef<HTMLDivElement>(null);
    const imgRef = React.useRef<HTMLImageElement>(null);
    const { meta, coverUrl, clearCover } = useSongCardMetadata({
      item,
      token,
      imgRef,
    });
    const isFlashOn = useHighlightFlash({
      isHighlighted,
      highlightTrigger,
      cardRef,
    });
    const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
    const [isThreeDotsMenuOpen, setIsThreeDotsMenuOpen] = useState(false);
    const [contextMenuPos, setContextMenuPos] = useState<{
      x: number;
      y: number;
    } | null>(null);
    const titleClass = `font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 ${isFlashOn || isPlaying ? "text-brand-primary!" : "text-gray-800 dark:text-gray-200"} group-hover:text-brand-primary`;

    const handleCardActivate = () => {
      if (isSelectionMode) {
        onToggleSelection?.(item.id);
        return;
      }
      if (item.isFolder) {
        onOpenFolder(item.id, meta.title);
        return;
      }
      const track = item.trackInfo;
      if (!track) return;
      onPlay({
        ...track,
        title: meta.title || track.title,
        artist: meta.artist || track.artist,
      });
    };

    const handleCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      handleCardActivate();
    };

    return (
      <div className="relative w-full">
        <div
          ref={cardRef}
          role="button"
          tabIndex={0}
          data-folder-id={item.isFolder ? item.id : undefined}
          onClick={handleCardActivate}
          onKeyDown={handleCardKeyDown}
          onContextMenu={(e) => {
            if (hideMenu) return;
            e.preventDefault();
            setContextMenuPos({ x: e.clientX, y: e.clientY });
            setIsContextMenuOpen(true);
          }}
          className={`group w-full rounded-xl cursor-pointer`}
        >
          <div
            className={`p-3 rounded-xl transition-all duration-300 flex items-center gap-4 active:scale-[0.98] w-full hover:shadow-md group-hover:-translate-y-1 ${cardStateClass(isFlashOn, isSelected, isPlaying)}`}
          >
            {isSelectionMode && (
              <div className="flex-shrink-0 flex items-center justify-center animate-in zoom-in duration-200">
                {isSelected ? (
                  <SquareCheckBig className="w-5 h-5 text-brand-primary" />
                ) : (
                  <Square className="w-5 h-5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400" />
                )}
              </div>
            )}
            <div
              className={`relative w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors ${item.isFolder ? "bg-amber-100 dark:bg-amber-900/30 text-amber-500" : `bg-gray-200 dark:bg-[#121212] group-hover:bg-brand-primary/10 group-hover:text-brand-primary ${isFlashOn || isPlaying ? "bg-brand-primary/10! text-brand-primary!" : "text-gray-400"}`}`}
            >
              {coverUrl && !item.isFolder ? (
                <img
                  ref={imgRef}
                  src={coverUrl}
                  alt={meta.title}
                  loading="lazy"
                  decoding="async"
                  width={48}
                  height={48}
                  // The src is already a blob URL built from the picture
                  // bytes — an error here means those bytes are corrupt, so
                  // drop to the Music icon (no retry chain exists anymore).
                  onError={clearCover}
                  className="w-full h-full object-cover"
                />
              ) : item.isFolder ? (
                <Folder className="w-6 h-6" fill="currentColor" />
              ) : (
                <Music className="w-6 h-6 opacity-80" />
              )}
            </div>
            <div className="overflow-hidden flex-1 flex flex-col justify-center">
              <h3 className={titleClass}>{meta.title}</h3>
              <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
                {item.isFolder ? (
                  <span className="truncate">{t("drive.folders")}</span>
                ) : (
                  <div className="flex items-center truncate">
                    {meta.loaded && (
                      <>
                        <span className="text-[11px] font-medium tracking-wide">
                          {/* Fix F: a 0/estimated duration is unknown — render
                              "–" instead of the fake "00:00:00" a placeholder
                              used to show. */}
                          {meta.duration > 0 && !meta.durationEstimated
                            ? formatDuration(meta.duration)
                            : "–"}
                        </span>
                        <span className="mx-2 text-gray-300 dark:text-gray-600">
                          •
                        </span>
                        <span className="text-[11px] font-medium tracking-wide">
                          {formatBytes(meta.size)}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            {!hideMenu && (
              <div
                className={`transition-opacity ml-2 shrink-0 ${isThreeDotsMenuOpen || isContextMenuOpen || isFlashOn ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
              >
                <MoreMenu
                  track={item.trackInfo}
                  driveItem={item}
                  token={token}
                  currentFolderId={currentFolderId}
                  currentFolderName={currentFolderName}
                  folderHistory={folderHistory}
                  onRefresh={onRefresh}
                  onRemoveItem={onRemoveItem}
                  variant={menuVariant}
                  forceOpen={isContextMenuOpen}
                  onClose={() => {
                    setIsContextMenuOpen(false);
                    setContextMenuPos(null);
                  }}
                  anchorPoint={contextMenuPos}
                  onOpenChange={setIsThreeDotsMenuOpen}
                  onSelectMultiple={() => {
                    onEnableSelectionMode?.(item.id);
                  }}
                  isBulkSelected={isSelectionMode && isSelected}
                  onBulkMoveClick={onBulkMoveClick}
                  onBulkDeleteClick={onBulkDeleteClick}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.item.id === next.item.id &&
      prev.item.title === next.item.title &&
      prev.item.isFolder === next.item.isFolder &&
      prev.item.trackInfo?.id === next.item.trackInfo?.id &&
      prev.item.trackInfo?.queueItemId === next.item.trackInfo?.queueItemId &&
      prev.item.size === next.item.size &&
      prev.isPlaying === next.isPlaying &&
      prev.isSelected === next.isSelected &&
      prev.isSelectionMode === next.isSelectionMode &&
      prev.isHighlighted === next.isHighlighted &&
      prev.highlightTrigger === next.highlightTrigger
    );
  },
);
