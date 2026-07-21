import React, { useState } from "react";
import { Folder, Music, Square, CheckSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DriveItem, Track } from "../../../App";
import { MoreMenu } from "../../components/MoreMenu";

// This app streams files straight from Google Drive: there is no cover-art
// pipeline at all. There IS an optional, read-only DB tag lookup, but it is
// wired up ONLY by MainContent.tsx for the "My Drive" list (via the
// `dbMetadata` prop below) — every other place that renders a SongCard
// (Home, Liked Songs, Playlists) omits the prop, so it just shows the plain
// Drive filename as before.

export interface DbTagMetadata {
  title: string;
  artist: string;
  duration: number;
}

function formatDuration(seconds: number): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

interface SongCardProps {
  item: DriveItem;
  onPlay: (track: Track) => void;
  onOpenFolder: (id: string, name: string) => void;
  token?: string | null;
  currentFolderId: string;
  currentFolderName: string;
  isHighlighted?: boolean;
  highlightTrigger?: number;
  folderHistory: {id: string, name: string}[];
  onRefresh: () => void;
  onRemoveItem?: (id: string) => void;
  isPlaying?: boolean;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelection?: () => void;
  onEnableSelectionMode?: () => void;
  hideMenu?: boolean;
  onBulkMoveClick?: () => void;
  onBulkDeleteClick?: () => void;
  /** DB-sourced tag (title/artist/duration). Only ever passed by MainContent
   * for the "My Drive" list — omitted everywhere else. */
  dbMetadata?: DbTagMetadata;
}

export const SongCard = React.memo(function SongCard({
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
  onBulkMoveClick,
  onBulkDeleteClick,
  dbMetadata,
}: SongCardProps) {
  const { t } = useTranslation();
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [isThreeDotsMenuOpen, setIsThreeDotsMenuOpen] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState<{x: number, y: number} | null>(null);

  React.useEffect(() => {
    if (isHighlighted && cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect();
      const headerHeight = 160;
      const playerBarHeight = 85;
      const isVisible = rect.top >= headerHeight && rect.bottom <= (window.innerHeight - playerBarHeight);

      if (!isVisible) {
        cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      let count = 0;
      setIsFlashOn(true);
      const interval = setInterval(() => {
        setIsFlashOn(prev => !prev);
        count++;
        if (count >= 7) {
          clearInterval(interval);
          setIsFlashOn(false);
        }
      }, 300);

      return () => {
        clearInterval(interval);
        setIsFlashOn(false);
      };
    }
  }, [isHighlighted, highlightTrigger]);

  const size = item.trackInfo?.size ?? 0;
  const displayTitle = dbMetadata?.title || item.title;
  const duration = dbMetadata?.duration ?? 0;

  return (
    <div
      className="relative group/card w-full"
      style={{
        contentVisibility: 'auto' as any,
        containIntrinsicSize: 'auto 92px' as any,
      }}
    >
      <div
        ref={cardRef}
        onClick={() => {
          if (isSelectionMode) {
            onToggleSelection?.();
          } else if (item.isFolder) {
            onOpenFolder(item.id, item.title);
          } else {
            onPlay({
              ...item.trackInfo!,
              title: dbMetadata?.title || item.trackInfo!.title,
              artist: dbMetadata?.artist || item.trackInfo!.artist,
            });
          }
        }}
        onContextMenu={(e) => {
          if (hideMenu) return;
          e.preventDefault();
          setContextMenuPos({ x: e.clientX, y: e.clientY });
          setIsContextMenuOpen(true);
        }}
        className={`p-3.5 rounded-2xl transition-[transform,box-shadow,background-color] duration-300 cursor-pointer flex items-center gap-4 active:scale-[0.98] group w-full ${
          isFlashOn
            ? 'bg-white dark:bg-[#383a40] shadow-lg shadow-black/5'
            : isSelected
              ? 'bg-[#4285F4]/10 dark:bg-[#4285F4]/20 hover:bg-[#4285F4]/20 dark:hover:bg-[#4285F4]/30'
              : isPlaying
                ? 'bg-[#F8F9FA] dark:bg-[#2a2b2f] shadow-sm group-hover/card:bg-white dark:group-hover/card:bg-[#383a40] group-hover/card:-translate-y-0.5'
                : 'bg-[#F8F9FA] dark:bg-[#202124] group-hover/card:bg-white dark:group-hover/card:bg-[#2a2b2f] group-hover/card:shadow-lg group-hover/card:shadow-black/5 group-hover/card:-translate-y-1'
        }`}
      >
      {isSelectionMode && (
        <div className="flex-shrink-0 flex items-center justify-center animate-in zoom-in duration-200">
          {isSelected ? (
            <CheckSquare className="w-5 h-5 text-[#4285F4]" />
          ) : (
            <Square className="w-5 h-5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400" />
          )}
        </div>
      )}
      <div className={`relative w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors ${item.isFolder ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-500' : `bg-gray-200 dark:bg-[#121212] group-hover:bg-[#4285F4]/10 group-hover:text-[#4285F4] ${isFlashOn || isPlaying ? '!bg-[#4285F4]/10 !text-[#4285F4]' : 'text-gray-400'}`}`}>
        {item.isFolder ? (
          <Folder className="w-6 h-6" fill="currentColor" />
        ) : (
          <Music className="w-6 h-6 opacity-80" />
        )}
      </div>
      <div className="overflow-hidden flex-1 flex flex-col justify-center">
        <h3 className={`font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 group-hover:text-[#4285F4] ${isFlashOn || isPlaying ? '!text-[#4285F4]' : 'text-gray-800 dark:text-gray-200'}`}>
          {displayTitle}
        </h3>
        <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
          {item.isFolder ? (
            <span className="truncate">{t('drive.folders')}</span>
          ) : (
            <div className="flex items-center truncate">
              {duration > 0 && (
                <>
                  <span className="text-[11px] font-medium tracking-wide">
                    {formatDuration(duration)}
                  </span>
                  {size > 0 && <span className="mx-2 text-gray-300 dark:text-gray-600">•</span>}
                </>
              )}
              {size > 0 && (
                <span className="text-[11px] font-medium tracking-wide">
                  {formatSize(size)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {!hideMenu && (
        <div className={`transition-opacity ml-2 shrink-0 ${isThreeDotsMenuOpen || isContextMenuOpen || isFlashOn ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          <MoreMenu
            track={item.trackInfo}
            driveItem={item}
            token={token}
            currentFolderId={currentFolderId}
            currentFolderName={currentFolderName}
            folderHistory={folderHistory}
            onRefresh={onRefresh}
            onRemoveItem={onRemoveItem}
            forceOpen={isContextMenuOpen}
            onClose={() => {
              setIsContextMenuOpen(false);
              setContextMenuPos(null);
            }}
            anchorPoint={contextMenuPos}
            onOpenChange={setIsThreeDotsMenuOpen}
            onSelectMultiple={() => {
              onEnableSelectionMode?.();
            }}
            isBulkSelected={isSelectionMode && isSelected}
            onBulkMoveClick={onBulkMoveClick}
            onBulkDeleteClick={onBulkDeleteClick}
          />
        </div>
      )}
    </div>
    </div>
  );
}, (prev, next) => {
  return prev.item.id === next.item.id &&
         prev.isPlaying === next.isPlaying &&
         prev.isSelected === next.isSelected &&
         prev.isSelectionMode === next.isSelectionMode &&
         prev.isHighlighted === next.isHighlighted &&
         prev.highlightTrigger === next.highlightTrigger &&
         prev.dbMetadata === next.dbMetadata;
});
