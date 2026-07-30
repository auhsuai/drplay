import React, { useState, useRef } from "react";
import { Folder, Music, Square, CheckSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DriveItem, Track } from "../../../App";
import { getTrackMetadata } from "../../../utils/metadata";
import { MoreMenu } from "../../components/MoreMenu";

export const coverImageCache = new Map<string, string>();
const COVER_CACHE_MAX = 500; // ~50KB max (100 bytes/cover URL string)

function classifyCardError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "UnknownError", message: String(err) };
}

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
  onBulkMoveClick?: () => void;
  onBulkDeleteClick?: () => void;
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
  onBulkDeleteClick
}: SongCardProps) {
  const { t } = useTranslation();
  const [coverUrl, setCoverUrl] = useState<string | null>(() => {
    return coverImageCache.get(item.id) ?? null;
  });
  const metadataRef = useRef({ title: item.title, artist: null as string | null, duration: 0, size: 0 });
  const [, forceRender] = useState(0);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [isThreeDotsMenuOpen, setIsThreeDotsMenuOpen] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState<{x: number, y: number} | null>(null);
  const [shouldFetch] = useState(true);

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

  React.useEffect(() => {
    if (item.isFolder || !token) return;

    const controller = new AbortController();
    let isMounted = true;
    let objectUrl: string | null = null;

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
        const old = metadataRef.current;
        if (newMeta.title !== old.title || newMeta.artist !== old.artist || newMeta.duration !== old.duration || newMeta.size !== old.size) {
          metadataRef.current = newMeta;
          forceRender(n => n + 1);
        }

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
          objectUrl = URL.createObjectURL(blob);
          setCoverUrl(objectUrl);
        }
      } catch (e) {
        const { name, message } = classifyCardError(e);
        console.warn('[SongCard] Failed to load track metadata', { id: item.id, name, message });
      }
    };

    const timerId = setTimeout(() => {
      fetchMetadata();
    }, 150); // Debounce: only fetch if card is visible for 150ms (avoids IPC spam when scrolling fast)

    const handleMetadataUpdated = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.fileId === item.id) {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
        fetchMetadata();
      }
    };

    window.addEventListener('metadata-updated', handleMetadataUpdated);

    return () => {
      isMounted = false;
      clearTimeout(timerId);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (imgRef.current) {
        imgRef.current.src = "";
      }
      window.removeEventListener('metadata-updated', handleMetadataUpdated);
    };
  }, [item.id, token, shouldFetch]);

  return (
    <div className="relative w-full">
      <div
        ref={cardRef}
        onClick={() => {
          if (isSelectionMode) {
            onToggleSelection?.(item.id);
          } else {
            item.isFolder ? onOpenFolder(item.id, metadataRef.current.title) : onPlay({
              ...item.trackInfo!,
              title: metadataRef.current.title || item.trackInfo!.title,
              artist: metadataRef.current.artist || item.trackInfo!.artist
            });
          }
        }}
        onContextMenu={(e) => {
          if (hideMenu) return;
          e.preventDefault();
          setContextMenuPos({ x: e.clientX, y: e.clientY });
          setIsContextMenuOpen(true);
        }}
        className="group w-full rounded-xl cursor-pointer"
      >
      <div className={`p-3 rounded-xl transition-all duration-300 flex items-center gap-4 active:scale-[0.98] w-full hover:shadow-md group-hover:-translate-y-1 ${
          isFlashOn
            ? 'bg-white dark:bg-[#383a40] shadow-lg shadow-black/5'
            : isSelected
              ? 'bg-[#4285F4]/10 dark:bg-[#4285F4]/20 hover:bg-[#4285F4]/20 dark:hover:bg-[#4285F4]/30'
              : isPlaying
                ? 'bg-[#F8F9FA] dark:bg-[#2a2b2f] shadow-sm hover:bg-white dark:hover:bg-[#383a40]'
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
          <img ref={imgRef} src={coverUrl} alt="cover" decoding="async" onError={() => setCoverUrl(null)} className="w-full h-full object-cover" />
        ) : item.isFolder ? (
          <Folder className="w-6 h-6" fill="currentColor" />
        ) : (
          <Music className="w-6 h-6 opacity-80" />
        )}
      </div>
      <div className="overflow-hidden flex-1 flex flex-col justify-center">
        <h3 className={`font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 group-hover:text-[#4285F4] ${isFlashOn || isPlaying ? '!text-[#4285F4]' : 'text-gray-800 dark:text-gray-200'}`}>
          {metadataRef.current.title}
        </h3>
        <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
          {item.isFolder ? (
            <span className="truncate">{t('drive.folders')}</span>
          ) : (
            <div className="flex items-center truncate">
              {(metadataRef.current.duration > 0 || metadataRef.current.size > 0) && (
                <>
                  <span className="text-[11px] font-medium tracking-wide">
                    {formatDuration(metadataRef.current.duration)}
                  </span>
                  {metadataRef.current.size > 0 && (
                    <>
                      <span className="mx-2 text-gray-300 dark:text-gray-600">•</span>
                      <span className="text-[11px] font-medium tracking-wide">
                        {formatSize(metadataRef.current.size)}
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
}, (prev, next) => {
  return prev.item.id === next.item.id &&
         prev.isPlaying === next.isPlaying &&
         prev.isSelected === next.isSelected &&
         prev.isSelectionMode === next.isSelectionMode &&
         prev.isHighlighted === next.isHighlighted &&
         prev.highlightTrigger === next.highlightTrigger;
});
