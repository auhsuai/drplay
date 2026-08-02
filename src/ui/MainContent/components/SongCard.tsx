import React, { useState } from "react";
import { Folder, Music, Square, CheckSquare, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DriveItem, Track } from "../../../App";
import { getTrackMetadata } from "../../../utils/metadata";
import { captureError } from "../../../utils/errorLog";
import { MoreMenu } from "../../components/MoreMenu";
import type { MoreMenuVariant } from "../../components/MoreMenu";
import type { UploadState } from "../../../utils/uploadManager";

const SONG_CARD_MODULE = 'SongCard';

export const coverImageCache = new Map<string, string>();
const COVER_CACHE_MAX = 500; // ~50KB max (100 bytes/cover URL string)
// Fixed chrome bands the card must stay within to count as "fully visible"
// (below the main header, above the player bar).
const HEADER_HEIGHT = 160;
const PLAYER_BAR_HEIGHT = 85;
// One on→off cycle for the navigate/locate highlight cue. The old
// implementation toggled isFlashOn 7× every 300ms (≈4 blinks) which looked broken.
const FLASH_DURATION_MS = 400;
// Accent tint for "selected (bulk mode)" cards. Playing cards deliberately do
// NOT use it: the user design wants the now-playing card to look exactly like
// the hovered idle card (gray bg + blue title/icon + soft shadow) but WITHOUT
// the hover lift, so it shares the idle hover palette instead of the accent.
const ACCENT_CARD_TINT = 'bg-[#4285F4]/10 dark:bg-[#4285F4]/20';
const ACCENT_CARD_TINT_HOVER = 'hover:bg-[#4285F4]/20 dark:hover:bg-[#4285F4]/30';

function formatDuration(seconds: number): string {
  if (!seconds) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
  onToggleSelection?: (id: string) => void;
  onEnableSelectionMode?: (id: string) => void;
  hideMenu?: boolean;
  menuVariant?: MoreMenuVariant;
  onBulkMoveClick?: () => void;
  onBulkDeleteClick?: () => void;
  uploadState?: UploadState;
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
  menuVariant,
  onBulkMoveClick,
  onBulkDeleteClick,
  uploadState = 'none',
}: SongCardProps) {
  const { t } = useTranslation();
  const [coverUrl, setCoverUrl] = useState<string | null>(() => {
    return coverImageCache.get(item.id) ?? null;
  });
  const [meta, setMeta] = useState<{ title: string; artist: string | null; duration: number; size: number }>({ title: item.title, artist: null, duration: 0, size: 0 });
  const cardRef = React.useRef<HTMLDivElement>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const blobUrlRef = React.useRef<string | null>(null);
  const releaseBlobUrl = React.useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [isThreeDotsMenuOpen, setIsThreeDotsMenuOpen] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState<{x: number, y: number} | null>(null);

  React.useEffect(() => {
    if (isHighlighted && cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect();
      const isVisible = rect.top >= HEADER_HEIGHT && rect.bottom <= (window.innerHeight - PLAYER_BAR_HEIGHT);

      if (!isVisible) {
        cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Single flash: one on→off cycle is the intended "located" cue. The old
      // implementation toggled isFlashOn 7× @ 300ms (≈4 blinks) which looked broken.
      setIsFlashOn(true);
      const timer = setTimeout(() => setIsFlashOn(false), FLASH_DURATION_MS);
      return () => {
        clearTimeout(timer);
        setIsFlashOn(false);
      };
    }
  }, [isHighlighted, highlightTrigger]);

  React.useEffect(() => {
    if (item.isFolder || !token) return;

    const controller = new AbortController();
    let isMounted = true;

      const fetchMetadata = async () => {
        try {
          const metadata = await getTrackMetadata(item.id, token, item.trackInfo?.size, item.trackInfo?.originalName, controller.signal);
          if (!isMounted) return;
        const newMeta = {
          title: metadata.title || item.title,
          artist: metadata.artist || null,
          duration: metadata.duration || 0,
          size: metadata.size || 0,
        };
        setMeta(prev => {
          if (newMeta.title === prev.title && newMeta.artist === prev.artist && newMeta.duration === prev.duration && newMeta.size === prev.size) {
            return prev;
          }
          return newMeta;
        });

        if (metadata.coverUrl) {
          coverImageCache.set(item.id, metadata.coverUrl);
          if (coverImageCache.size > COVER_CACHE_MAX) {
            const oldest = coverImageCache.keys().next().value;
            if (oldest !== undefined) coverImageCache.delete(oldest);
          }
        }
        if (metadata.coverUrl) {
          setCoverUrl(metadata.coverUrl);
        } else if (metadata.pictureData && metadata.pictureFormat) {
          const blob = new Blob([new Uint8Array(metadata.pictureData)], { type: metadata.pictureFormat });
          releaseBlobUrl();
          blobUrlRef.current = URL.createObjectURL(blob);
          setCoverUrl(blobUrlRef.current);
        }
      } catch (e) {
        if (controller.signal.aborted) return;   // deliberate cleanup abort — not an error (MDN AbortController)
        captureError({ level: 'warn', source: SONG_CARD_MODULE, message: `metadata-load-failed (fileId=${item.id}): ${e instanceof Error ? e.message : String(e)}` });
      }
    };

    const timerId = setTimeout(() => {
      fetchMetadata();
    }, 150); // Debounce: only fetch if card is visible for 150ms (avoids IPC spam when scrolling fast)

    const handleMetadataUpdated = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.fileId === item.id) {
        fetchMetadata();
      }
    };

    window.addEventListener('metadata-updated', handleMetadataUpdated);

    return () => {
      isMounted = false;
      clearTimeout(timerId);
      controller.abort();
      releaseBlobUrl();
      if (imgRef.current) {
        imgRef.current.src = "";
      }
      window.removeEventListener('metadata-updated', handleMetadataUpdated);
    };
  }, [item.id, token]);

  const handleCardActivate = () => {
    // Upload race guard (UI layer): an item that is still uploading must not
    // play / open / select. pointer-events-none handles the mouse; keyboard
    // (Enter/Space) reaches this handler directly, so the guard lives here.
    if (uploadState === 'uploading') return;
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
      artist: meta.artist || track.artist
    });
  };

  const handleCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleCardActivate();
  };

  return (
    <div className="relative w-full">
      <div
        ref={cardRef}
        role="button"
        tabIndex={0}
        onClick={handleCardActivate}
        onKeyDown={handleCardKeyDown}
        onContextMenu={(e) => {
          if (hideMenu) return;
          e.preventDefault();
          setContextMenuPos({ x: e.clientX, y: e.clientY });
          setIsContextMenuOpen(true);
        }}
        className={`group w-full rounded-xl cursor-pointer ${uploadState === 'uploading' ? 'opacity-50 pointer-events-none' : ''}`}
      >
      <div className={`p-3 rounded-xl transition-all duration-300 flex items-center gap-4 active:scale-[0.98] w-full hover:shadow-md group-hover:-translate-y-1 ${
          isFlashOn
            ? 'bg-white dark:bg-[#383a40] shadow-lg shadow-black/5'
            : isSelected
              ? `${ACCENT_CARD_TINT} ${ACCENT_CARD_TINT_HOVER}`
              : isPlaying
                ? 'bg-gray-100 dark:bg-[#2a2b2f] shadow-sm'
                : 'bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f]'
        }`}>
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
        {coverUrl && !item.isFolder ? (
          <img ref={imgRef} src={coverUrl} alt={meta.title} decoding="async" onError={() => setCoverUrl(null)} className="w-full h-full object-cover" />
        ) : item.isFolder ? (
          <Folder className="w-6 h-6" fill="currentColor" />
        ) : (
          <Music className="w-6 h-6 opacity-80" />
        )}
      </div>
      <div className="overflow-hidden flex-1 flex flex-col justify-center">
        <h3 className={`font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 group-hover:text-[#4285F4] ${isFlashOn || isPlaying ? '!text-[#4285F4]' : 'text-gray-800 dark:text-gray-200'}`}>
          {meta.title}
        </h3>
        <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
          {item.isFolder ? (
            <span className="truncate">{t('drive.folders')}</span>
          ) : (
            <div className="flex items-center truncate">
              {(meta.duration > 0 || meta.size > 0) && (
                <>
                  <span className="text-[11px] font-medium tracking-wide">
                    {formatDuration(meta.duration)}
                  </span>
                  {meta.size > 0 && (
                    <>
                      <span className="mx-2 text-gray-300 dark:text-gray-600">•</span>
                      <span className="text-[11px] font-medium tracking-wide">
                        {formatSize(meta.size)}
                      </span>
                    </>
                  )}
                </>
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
      {uploadState === 'uploading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-[#4285F4]" />
        </div>
      )}
      {uploadState === 'parent-uploading' && (
        <div className="absolute top-2 right-2 pointer-events-none">
          <Loader2 className="w-4 h-4 animate-spin text-[#4285F4]" />
        </div>
      )}
      </div>
    </div>
    </div>
  );
}, (prev, next) => {
  return prev.item.id === next.item.id &&
         prev.item.title === next.item.title &&
         prev.item.isFolder === next.item.isFolder &&
         prev.item.trackInfo?.id === next.item.trackInfo?.id &&
         prev.item.trackInfo?.queueItemId === next.item.trackInfo?.queueItemId &&
         prev.item.size === next.item.size &&
         prev.isPlaying === next.isPlaying &&
         prev.isSelected === next.isSelected &&
         prev.isSelectionMode === next.isSelectionMode &&
         prev.isHighlighted === next.isHighlighted &&
         prev.highlightTrigger === next.highlightTrigger &&
         prev.uploadState === next.uploadState;
});
