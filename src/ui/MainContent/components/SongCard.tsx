import React, { useState } from "react";
import {
  Folder,
  Music,
  Square,
  CheckSquare,
  LoaderCircle,
  X,
  Check,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../../App";
import type { DriveItem } from "../../../types";
import { getTrackMetadata } from "../../../utils/metadata";
import { buildCoverBlobUrl } from "../../../utils/coverStore";
import { formatBytes } from "../../../utils/formatBytes";
import { captureError } from "../../../utils/errorLog";
import { MoreMenu } from "../../components/MoreMenu";
import type { MoreMenuVariant } from "../../components/MoreMenu";
import { cancelUpload, dismissUploaded } from "../../../utils/uploadManager";
import type { UploadState } from "../../../utils/uploadManager";
import { DRAG_FOLDER_HOVER_EVENT } from "../../components/DropZone";

const SONG_CARD_MODULE = "SongCard";

// Determinate upload ring (replaces the old centered spinner): 24-unit
// viewBox, stroke 2, radius 10 keeps the stroke fully inside the box
// (radius = center - stroke per the CSS-Tricks progress-ring pattern).
const RING_VIEWBOX = "0 0 24 24";
const RING_CENTER = 12;
const RING_RADIUS = 10;
const RING_STROKE_WIDTH = 2;
// dashoffset = C × (1 − fraction) draws the visible arc; the -90° rotation
// makes it start at 12 o'clock instead of the default 3 o'clock.
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_ROTATION = "rotate(-90 12 12)";
const PROGRESS_MIN = 0;
const PROGRESS_MAX = 1;

// Progress fractions can overshoot (Drive confirms bytes out of order) — clamp
// to a valid arc; undefined/NaN (no progress reported yet) mean "just started".
function clampFraction(fraction: number | undefined): number {
  if (fraction === undefined || !Number.isFinite(fraction)) return PROGRESS_MIN;
  return Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, fraction));
}

function ProgressRing({ fraction }: { fraction: number }): React.JSX.Element {
  const percent = Math.round(fraction * 100);
  return (
    <svg
      className="w-5 h-5 shrink-0"
      viewBox={RING_VIEWBOX}
      role="img"
      // The % is announced to screen readers only — the ring itself stays a
      // pure arc (user design: no number inside the ring next to the title).
      aria-label={`${String(percent)}%`}
    >
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE_WIDTH}
        className="stroke-gray-200 dark:stroke-[#3c4043]"
      />
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
        transform={RING_ROTATION}
        className="stroke-[#4285F4]"
      />
    </svg>
  );
}

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
const ACCENT_CARD_TINT = "bg-[#4285F4]/10 dark:bg-[#4285F4]/20";
const ACCENT_CARD_TINT_HOVER =
  "hover:bg-[#4285F4]/20 dark:hover:bg-[#4285F4]/30";

function formatDuration(seconds: number): string {
  if (!seconds) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

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
  uploadState?: UploadState | undefined;
  uploadProgress?: number | undefined;
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
    uploadState = "none",
    uploadProgress,
  }: SongCardProps) {
    const { t } = useTranslation();
    const [coverUrl, setCoverUrl] = useState<string | null>(null);
    // loaded=true only after getTrackMetadata resolves, so the meta row (duration
    // • size) appears only for real metadata — the old size>0 guard also hid
    // legitimate 0-byte files, which must show "0 B" (formatBytes semantics).
    const [meta, setMeta] = useState<{
      title: string;
      artist: string | null;
      duration: number;
      durationEstimated: boolean;
      size: number;
      loaded: boolean;
    }>({
      title: item.title,
      artist: null,
      duration: 0,
      durationEstimated: false,
      size: 0,
      loaded: false,
    });
    const cardRef = React.useRef<HTMLDivElement>(null);
    const imgRef = React.useRef<HTMLImageElement>(null);
    const [isFlashOn, setIsFlashOn] = useState(false);
    const [isDragHovered, setIsDragHovered] = useState(false);
    const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
    const [isThreeDotsMenuOpen, setIsThreeDotsMenuOpen] = useState(false);
    const [contextMenuPos, setContextMenuPos] = useState<{
      x: number;
      y: number;
    } | null>(null);
    // Drag-over ("drop target") visual mirrors the real mouse-hover classes 1:1
    // (shadow-md + -translate-y-1, gray bg in the idle branch, accent tint in
    // the selected branch) but rendered unconditionally — there is no :hover
    // state while the OS drag is in flight. The bg classes carry the Tailwind
    // important modifier (trailing !) because the card base bg (`bg-[#F8F9FA]
    // dark:bg-[#202124]`) has the same specificity and generated-CSS order
    // would otherwise decide — the existing bg-[#4285F4]/10! icon pattern is
    // the same trick. The flash branch keeps its own bg: it is transient
    // (400ms) and already overrides every other state.
    const dragHoverClasses = isDragHovered
      ? `shadow-md -translate-y-1 ${isSelected ? "bg-[#4285F4]/20! dark:bg-[#4285F4]/30!" : isFlashOn ? "" : "bg-gray-100! dark:bg-[#2a2b2f]!"}`
      : "";
    // Shared by the idle and uploading title rows; the uploading row adds
    // flex-1 min-w-0 so the h3 truncates instead of pushing the ring out.
    // Drag-over mirrors the real group-hover accent on the title too — during
    // an OS drag there is no :hover, so the accent must be forced on.
    const titleClass = `font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 ${isDragHovered || isFlashOn || isPlaying ? "text-[#4285F4]!" : "text-gray-800 dark:text-gray-200"} ${isDragHovered ? "" : "group-hover:text-[#4285F4]"}`;

    React.useEffect(() => {
      if (isHighlighted && cardRef.current) {
        const rect = cardRef.current.getBoundingClientRect();
        const isVisible =
          rect.top >= HEADER_HEIGHT &&
          rect.bottom <= window.innerHeight - PLAYER_BAR_HEIGHT;

        if (!isVisible) {
          cardRef.current.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }

        // Single flash: one on→off cycle is the intended "located" cue. The old
        // implementation toggled isFlashOn 7× @ 300ms (≈4 blinks) which looked broken.
        setIsFlashOn(true);
        const timer = setTimeout(() => {
          setIsFlashOn(false);
        }, FLASH_DURATION_MS);
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
      // The metadata effect cleanup touches the img element; capture it at
      // setup so the cleanup never reads the (possibly stale) ref
      // (react-hooks/exhaustive-deps ref-cleanup rule).
      const imgElement = imgRef.current;

      const fetchMetadata = async () => {
        try {
          const metadata = await getTrackMetadata(
            item.id,
            token,
            item.trackInfo?.size,
            item.trackInfo?.originalName,
            controller.signal,
          );
          if (!isMounted) return;
          const newMeta = {
            title: metadata.title || item.title,
            artist: metadata.artist || null,
            duration: metadata.duration || 0,
            durationEstimated: metadata.durationEstimated,
            // Old cached placeholders (pre-fix) carry no size — fall back to
            // the Drive listing size so a failed metadata fetch never shows
            // "0 B" next to real sizes (a true 0-byte file keeps "0 B": ?? only
            // falls back on null/undefined, not on a real 0).
            size: metadata.size ?? item.trackInfo?.size ?? 0,
            loaded: true,
          };
          setMeta((prev) => {
            if (
              newMeta.title === prev.title &&
              newMeta.artist === prev.artist &&
              newMeta.duration === prev.duration &&
              newMeta.durationEstimated === prev.durationEstimated &&
              newMeta.size === prev.size &&
              newMeta.loaded === prev.loaded
            ) {
              return prev;
            }
            return newMeta;
          });

          // Fix G: Chromium/WebView2 rejects the drplay:// custom scheme at the
          // network stack (ERR_UNKNOWN_URL_SCHEME) before the Rust handler can
          // respond, so the cover renders straight from a blob URL built with
          // the picture bytes metadata already parsed — no failed <img> cycle
          // and no scheme round-trip. A missing picture keeps the icon.
          // Full (≤1000px) bytes win over the 256px thumb — the grid cards
          // must show the sharp cover, not the blurry placeholder-sized one.
          const coverBytes = metadata.pictureDataFull ?? metadata.pictureData;
          setCoverUrl(
            coverBytes
              ? buildCoverBlobUrl(coverBytes, metadata.pictureFormat)
              : null,
          );
        } catch (e) {
          if (controller.signal.aborted) return; // deliberate cleanup abort — not an error (MDN AbortController)
          void captureError({
            level: "warn",
            source: SONG_CARD_MODULE,
            message: `metadata-load-failed (fileId=${item.id}): ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      };

      const timerId = setTimeout(() => {
        void fetchMetadata();
      }, 150); // Debounce: only fetch if card is visible for 150ms (avoids IPC spam when scrolling fast)

      const handleMetadataUpdated = (e: Event) => {
        // detail is typed | null because a CustomEvent constructed without
        // the detail option defaults to null at runtime.
        const customEvent = e as CustomEvent<{ fileId?: string } | null>;
        if (customEvent.detail?.fileId === item.id) {
          void fetchMetadata();
        }
      };

      window.addEventListener("metadata-updated", handleMetadataUpdated);

      return () => {
        isMounted = false;
        clearTimeout(timerId);
        controller.abort();
        if (imgElement) {
          imgElement.src = "";
        }
        window.removeEventListener("metadata-updated", handleMetadataUpdated);
      };
    }, [
      item.id,
      token,
      item.isFolder,
      item.title,
      item.trackInfo?.originalName,
      item.trackInfo?.size,
    ]);

    // DropZone's native drag-drop never triggers DOM hover, so folder cards
    // subscribe to its CustomEvent bus. The compare-then-set pattern keeps
    // non-target cards from re-rendering, and identical values bail React out —
    // repeated 'over' events on the same folder produce no flicker.
    React.useEffect(() => {
      if (!item.isFolder) return;
      const handleDragHover = (e: Event) => {
        const detail = (e as CustomEvent<{ folderId: string | null } | null>)
          .detail;
        setIsDragHovered(detail?.folderId === item.id);
      };
      window.addEventListener(DRAG_FOLDER_HOVER_EVENT, handleDragHover);
      return () => {
        window.removeEventListener(DRAG_FOLDER_HOVER_EVENT, handleDragHover);
      };
    }, [item.id, item.isFolder]);

    const handleCardActivate = () => {
      // Upload race guard (UI layer): an item that is still uploading must not
      // play / open / select. pointer-events-none handles the mouse; keyboard
      // (Enter/Space) reaches this handler directly, so the guard lives here.
      if (uploadState === "uploading") return;
      if (isSelectionMode) {
        onToggleSelection?.(item.id);
        return;
      }
      if (item.isFolder) {
        onOpenFolder(item.id, meta.title);
        return;
      }
      // Playing the item clears the transient "uploaded" check — the row goes
      // back to the idle MoreMenu (the check is only a completion cue).
      dismissUploaded(item.id);
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
          className={`group group/upload w-full rounded-xl cursor-pointer ${uploadState === "uploading" ? "opacity-50 pointer-events-none" : ""}`}
        >
          <div
            className={`p-3 rounded-xl transition-all duration-300 flex items-center gap-4 active:scale-[0.98] w-full hover:shadow-md group-hover:-translate-y-1 ${
              isFlashOn
                ? "bg-white dark:bg-[#383a40] shadow-lg shadow-black/5"
                : isSelected
                  ? `${ACCENT_CARD_TINT} ${ACCENT_CARD_TINT_HOVER}`
                  : isPlaying
                    ? "bg-gray-100 dark:bg-[#2a2b2f] shadow-sm"
                    : "bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"
            } ${dragHoverClasses}`}
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
            <div
              className={`relative w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors ${item.isFolder ? "bg-amber-100 dark:bg-amber-900/30 text-amber-500" : `bg-gray-200 dark:bg-[#121212] group-hover:bg-[#4285F4]/10 group-hover:text-[#4285F4] ${isFlashOn || isPlaying ? "bg-[#4285F4]/10! text-[#4285F4]!" : "text-gray-400"}`}`}
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
                  onError={() => {
                    // The src is already a blob URL built from the picture
                    // bytes — an error here means those bytes are corrupt, so
                    // drop to the Music icon (no retry chain exists anymore).
                    setCoverUrl(null);
                  }}
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
                className={`transition-opacity ml-2 shrink-0 ${uploadState === "uploading" || uploadState === "uploaded" || isThreeDotsMenuOpen || isContextMenuOpen || isFlashOn ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
              >
                {uploadState === "uploading" ? (
                  // The determinate ring lives where the menu sits (right edge), not
                  // next to the title. Hovering the ring reveals the X cancel button
                  // inside it (pointer-events-auto: the dimmed card is
                  // pointer-events-none, but cancel must stay clickable).
                  <div className="relative w-5 h-5 shrink-0">
                    <ProgressRing fraction={clampFraction(uploadProgress)} />
                    <button
                      type="button"
                      aria-label={t("upload.cancel_upload")}
                      className="pointer-events-auto absolute inset-0 flex items-center justify-center rounded-full opacity-0 group-hover/upload:opacity-100 hover:text-red-500 transition-opacity text-gray-500"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelUpload(item.id);
                      }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : uploadState === "uploaded" ? (
                  // Just-finished upload: single-tick check (user design) in place
                  // of the menu; disappears on play, on tab switch, or after the
                  // short tint.
                  <div
                    className="w-5 h-5 flex items-center justify-center pointer-events-none"
                    aria-label={t("upload.uploaded")}
                  >
                    <Check className="w-4 h-4 text-[#4285F4]" />
                  </div>
                ) : (
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
                )}
              </div>
            )}
            {uploadState === "parent-uploading" && (
              <div className="absolute top-2 right-2 pointer-events-none">
                <LoaderCircle className="w-4 h-4 animate-spin text-[#4285F4]" />
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
      prev.highlightTrigger === next.highlightTrigger &&
      prev.uploadState === next.uploadState &&
      prev.uploadProgress === next.uploadProgress
    );
  },
);
