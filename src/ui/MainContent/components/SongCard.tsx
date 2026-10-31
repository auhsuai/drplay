import React, { useState } from "react";
import { Folder, Music, Square, SquareCheckBig } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../../types";
import type { DriveItem } from "../../../types";
import { formatBytes } from "../../../utils/formatBytes";
import { isVideoFile } from "../../../utils/audioQuery";
import { MoreMenu } from "../../components/MoreMenu";
import type { MoreMenuVariant } from "../../components/MoreMenu";
import { formatDuration } from "../utils/formatDuration";
import {
  LIST_ACTIONS_TRACK,
  LIST_DATE_TRACK,
  LIST_GAP,
  LIST_ICON_TRACK,
  LIST_ROW_PADDING,
  LIST_SIZE_TRACK,
} from "./listColumnLayout";
import {
  useHighlightFlash,
  ACCENT_CARD_TINT,
  ACCENT_CARD_TINT_HOVER,
} from "../hooks/useHighlightFlash";
import { useSongCardMetadata } from "../hooks/useSongCardMetadata";

interface SongCardProps {
  item: DriveItem;
  onPlay: (track: Track) => void;
  // Optional parentId: search folder hits carry their real Drive parent so
  // navigation can rebuild a cross-branch breadcrumb; listing rows and legacy
  // callers omit it (plain drill-down append). Kept optional so the 2-arg
  // call shape stays valid where the parent is unknown.
  onOpenFolder: (id: string, name: string, parentId?: string) => void;
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
  // Virtual root ("Root Folders") rows are navigation targets with no real
  // date/size, and the column header is hidden there — so the two "—"
  // placeholders would float with no header above them. When true, both
  // column cells are omitted; everything else renders unchanged.
  hideColumns?: boolean;
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

// DriveItem.size is the listing's parsed byte count (number | undefined);
// folders and missing values have none. Malformed values fall back to "—"
// instead of formatBytes' "0 B" (same policy as TrashItemRow.formatSize).
function formatSize(size?: number): string {
  if (size === undefined || !Number.isFinite(size)) return "—";
  return formatBytes(size);
}

// Real modifiedTime in the Date column: locale date for every row (folders
// included), "—" for missing/malformed — never a fabricated date (same
// policy as TrashItemRow.formatDeletedDate). Zero-padded day/month
// (01/01/2025, not 1/1/2025); the locale still owns the field order.
function formatModifiedDate(raw?: string): string {
  if (raw === undefined || raw === "") return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// Inline film icon for files the shared isVideoFile allowlist classifies as
// video. Exact lucide `film` artwork (lucide.dev/icons/film, ISC license) —
// rendered inline so the classification and artwork live next to the card's
// other icons without a second lucide import. Same artwork TrashItemRow
// ships; w-6 h-6 because this card's tile is w-12 (Trash's tile is w-8 with
// w-4 icons — same proportion).
function FilmIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lucide lucide-film w-6 h-6"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18" />
      <path d="M3 7.5h4" />
      <path d="M3 12h18" />
      <path d="M3 16.5h4" />
      <path d="M17 3v18" />
      <path d="M17 7.5h4" />
      <path d="M17 16.5h4" />
    </svg>
  );
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
    hideColumns = false,
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
    const titleClass = `font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 ${isFlashOn || isPlaying ? "text-brand-text!" : "text-gray-800 dark:text-gray-200"} group-hover:text-brand-text`;

    // Full Drive filename (extension included) for files; folders have no
    // trackInfo and keep the listing title. The ID3 title from the async
    // metadata deliberately does NOT replace the displayed name — the user
    // wants rows to read exactly like the Drive filename (Trash parity).
    const displayName = item.isFolder
      ? item.title
      : (item.trackInfo?.originalName ?? item.title);

    const handleCardActivate = () => {
      if (isSelectionMode) {
        onToggleSelection?.(item.id);
        return;
      }
      if (item.isFolder) {
        // Folders keep the breadcrumb name from the listing; only the
        // parentId plumbing is special here. Two-arg call when the parent is
        // unknown preserves the drill-down path exactly.
        if (item.parentId !== undefined) {
          onOpenFolder(item.id, item.title, item.parentId);
        } else {
          onOpenFolder(item.id, item.title);
        }
        return;
      }
      const track = item.trackInfo;
      if (!track) return;
      // The queue entry keeps the full filename as its display title so the
      // player bar reads like the Drive row it was started from; ID3 only
      // fills the artist.
      onPlay({
        ...track,
        title: track.originalName || track.title,
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
            className={`${LIST_ROW_PADDING} rounded-xl transition-all duration-300 flex items-center ${LIST_GAP} active:scale-[0.98] w-full hover:shadow-md group-hover:-translate-y-1 ${cardStateClass(isFlashOn, isSelected, isPlaying)}`}
          >
            {isSelectionMode && (
              <div className="flex-shrink-0 flex items-center justify-center animate-in zoom-in duration-200">
                {isSelected ? (
                  <SquareCheckBig className="w-5 h-5 text-brand-text" />
                ) : (
                  <Square className="w-5 h-5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400" />
                )}
              </div>
            )}
            <div
              className={`relative ${LIST_ICON_TRACK} h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors ${item.isFolder ? "bg-amber-100 dark:bg-amber-900/30 text-amber-500" : `bg-gray-200 dark:bg-[#121212] group-hover:bg-brand-primary/10 group-hover:text-brand-text ${isFlashOn || isPlaying ? "bg-brand-primary/10! text-brand-text!" : "text-gray-400"}`}`}
            >
              {coverUrl && !item.isFolder ? (
                <img
                  ref={imgRef}
                  src={coverUrl}
                  alt={displayName}
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
              ) : isVideoFile(undefined, item.trackInfo?.originalName ?? "") ? (
                <FilmIcon />
              ) : (
                <Music className="w-6 h-6 opacity-80" />
              )}
            </div>
            <div className="overflow-hidden flex-1 flex flex-col justify-center">
              <h3 className={titleClass}>{displayName}</h3>
              <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
                {item.isFolder ? (
                  <span className="truncate">{t("drive.folders")}</span>
                ) : (
                  <div className="flex items-center truncate">
                    {/* Duration-only subtitle: the size moved to the Size
                        column (item.size, always visible) so it no longer
                        waits for the async metadata load here. */}
                    {meta.loaded && (
                      <span className="text-[11px] font-medium tracking-wide">
                        {/* Fix F: a 0/estimated duration is unknown — render
                            "–" instead of the fake "00:00:00" a placeholder
                            used to show. */}
                        {meta.duration > 0 && !meta.durationEstimated
                          ? formatDuration(meta.duration)
                          : "–"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* Date + Size columns. Typography matches the filename
                (text-sm font-medium) with its exact color tokens
                (text-gray-800 dark:text-gray-200 via titleClass) — one tone
                dimmer, not a separate secondary style. Tracks come from the
                shared column grid (listColumnLayout.ts) so this row and the
                FileListHeader stay pixel-aligned. Data renders straight from
                the listing — no metadata-load gate — so every row shows its
                date/size immediately. Hidden entirely on virtual-root rows
                (hideColumns), where the header is hidden and the values are
                meaningless placeholders. */}
            {!hideColumns && (
              <>
                <span
                  className={`${LIST_DATE_TRACK} text-sm font-medium text-gray-700 dark:text-gray-300 tabular-nums`}
                >
                  {formatModifiedDate(item.modifiedTime)}
                </span>
                <span
                  className={`${LIST_SIZE_TRACK} text-sm font-medium text-gray-700 dark:text-gray-300 tabular-nums`}
                >
                  {formatSize(item.size)}
                </span>
              </>
            )}
            {!hideMenu && (
              // Same fixed actions box as the header's trailing spacer (36px);
              // the parent gap-4 provides the spacing, so no ml-2 here.
              <div
                className={`${LIST_ACTIONS_TRACK} flex items-center justify-end shrink-0 transition-opacity ${isThreeDotsMenuOpen || isContextMenuOpen || isFlashOn ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
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
      prev.item.parentId === next.item.parentId &&
      prev.item.trackInfo?.id === next.item.trackInfo?.id &&
      prev.item.trackInfo?.queueItemId === next.item.trackInfo?.queueItemId &&
      // The h3 renders trackInfo.originalName (full filename with extension).
      // Without this check a rename that keeps the extension-stripped title
      // identical (e.g. extension case change) would leave the stale name.
      prev.item.trackInfo?.originalName === next.item.trackInfo?.originalName &&
      prev.item.size === next.item.size &&
      // The Date column renders modifiedTime — without this check a
      // delta-sync update that changes it re-sorts the list but leaves the
      // mounted card rendering the stale date.
      prev.item.modifiedTime === next.item.modifiedTime &&
      prev.isPlaying === next.isPlaying &&
      prev.isSelected === next.isSelected &&
      prev.isSelectionMode === next.isSelectionMode &&
      prev.isHighlighted === next.isHighlighted &&
      prev.highlightTrigger === next.highlightTrigger
    );
  },
);
