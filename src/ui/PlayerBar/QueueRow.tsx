import { useCallback, useRef, useState } from "react";
import { Check, Music } from "lucide-react";
import type { Track } from "../../types";
import type { CachedMetadata } from "../../utils/metadata";
import { formatBytes } from "../../utils/formatBytes";
import { useAuthStore } from "../../store/authStore";
import { captureError } from "../../utils/errorLog";
import {
  useTrackMetadata,
  TRACK_METADATA_DEBOUNCE_MS,
} from "../../hooks/useTrackMetadata";
import { MoreMenu } from "../components/MoreMenu";
import { formatDuration } from "../MainContent/utils/formatDuration";

// Fixed row height: the virtualizer (QueueList) uses it as the exact estimate
// (no measureElement round-trips) and the row style pins it, so offsets can
// never drift from the rendered height. 84 = 72px card (48px SongCard cover
// tile + p-3 vertical padding 12+12) + 12px gap, mirroring the file tab's
// pb-3 row spacing (VirtualizedSongList). Single source of truth: QueueList
// estimateSize + row style consume this constant.
export const QUEUE_ROW_HEIGHT = 84;

const QUEUE_ROW_MODULE = "QueueRow";

export interface QueueRowProps {
  track: Track;
  isCurrent: boolean;
  isChecked: boolean;
  selectionMode: boolean;
  onActivate: () => void;
  onToggleSelected: () => void;
  onRemoveFromQueue: () => void;
  onRemoveFolderFromQueue?: (() => void) | undefined;
}

function QueueRowCheckbox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => {
          // The row's click is a separate activation — a checkbox click must
          // only toggle the checkbox, never also select the row.
          e.stopPropagation();
        }}
        aria-label={label}
        className="peer appearance-none w-4 h-4 rounded border-2 border-gray-400 dark:border-gray-500 bg-white dark:bg-[#2a2b2f] checked:bg-brand-primary checked:border-brand-primary cursor-pointer transition-colors"
      />
      <Check
        className="absolute inset-0 m-auto w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none"
        strokeWidth={3}
      />
    </span>
  );
}

/**
 * One queue entry: SongCard-cloned card (48px cover tile, 15px semibold
 * title, duration • size subtitle) with the queue semantics kept — the
 * playing row is not a control (aria-current, no select/removal) and the
 * row menu stays always visible (no hover-reveal: 400px drawer + touch).
 */
export function QueueRow({
  track,
  isCurrent,
  isChecked,
  selectionMode,
  onActivate,
  onToggleSelected,
  onRemoveFromQueue,
  onRemoveFolderFromQueue,
}: QueueRowProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  // Token via the store snapshot — the TrackInfo path (PlayerBar reads the
  // store because the login gate mounts the player only after auth). No prop
  // drilling through QueuePanel/QueueList needed.
  const authToken = useAuthStore.getState().accessToken;
  const [meta, setMeta] = useState({
    duration: 0,
    durationEstimated: false,
    size: track.size ?? 0,
    loaded: false,
  });

  const onMetadata = useCallback(
    (metadata: CachedMetadata) => {
      const next = {
        duration: metadata.duration || 0,
        durationEstimated: metadata.durationEstimated,
        // Old cached placeholders carry no size — fall back to the Track
        // size (SongCard adapter parity); a true 0-byte file keeps "0 B".
        size: metadata.size ?? track.size ?? 0,
        loaded: true,
      };
      setMeta((prev) =>
        prev.duration === next.duration &&
        prev.durationEstimated === next.durationEstimated &&
        prev.size === next.size &&
        prev.loaded === next.loaded
          ? prev
          : next,
      );
    },
    [track.size],
  );

  const onError = useCallback(
    (error: unknown) => {
      void captureError({
        level: "warn",
        source: QUEUE_ROW_MODULE,
        message: `metadata-load-failed (fileId=${track.id}): ${error instanceof Error ? error.message : String(error)}`,
      });
    },
    [track.id],
  );

  // The shared debounced + mem-cached pipeline (SongCard grid parity: the
  // 150ms window exists for multi-card mounts; mem-cache + inflight dedup in
  // getTrackMetadata coalesce the rest) — no fetch per render, no new layer.
  const { coverUrl, setCoverUrl } = useTrackMetadata({
    fileId: track.id,
    token: authToken,
    size: track.size,
    originalName: track.originalName,
    enabled: !!authToken,
    debounceMs: TRACK_METADATA_DEBOUNCE_MS,
    imgRef,
    onMetadata,
    onError,
  });

  const clearCover = useCallback(() => {
    setCoverUrl(null);
  }, [setCoverUrl]);

  // SongCard title parity (no flash state in the queue): brand when current,
  // brand on hover.
  const titleClass = `font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 ${isCurrent ? "text-brand-primary!" : "text-gray-800 dark:text-gray-200"} group-hover:text-brand-primary`;

  const content = (
    <div
      className={`p-3 rounded-xl transition-all duration-300 flex items-center gap-4 w-full ${
        isCurrent
          ? "bg-gray-100 dark:bg-[#2a2b2f] shadow-sm"
          : "bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md group-hover:-translate-y-1 active:scale-[0.98]"
      }`}
    >
      {selectionMode && !isCurrent && (
        <QueueRowCheckbox
          checked={isChecked}
          label={track.title}
          onToggle={onToggleSelected}
        />
      )}

      <div
        className={`relative w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-gray-200 dark:bg-[#121212] group-hover:bg-brand-primary/10 group-hover:text-brand-primary ${isCurrent ? "bg-brand-primary/10! text-brand-primary!" : "text-gray-400"}`}
      >
        {coverUrl ? (
          <img
            ref={imgRef}
            src={coverUrl}
            alt={track.title}
            loading="lazy"
            decoding="async"
            width={48}
            height={48}
            // The src is already a blob URL built from the picture bytes —
            // an error here means those bytes are corrupt, so drop to the
            // Music icon (SongCard parity, no retry chain).
            onError={clearCover}
            className="w-full h-full object-cover"
          />
        ) : (
          <Music className="w-6 h-6 opacity-80" />
        )}
      </div>

      <div className="overflow-hidden flex-1 flex flex-col justify-center">
        <h3 className={titleClass}>{track.title}</h3>
        <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
          <div className="flex items-center truncate">
            {meta.loaded && (
              <>
                <span className="text-[11px] font-medium tracking-wide">
                  {/* A 0/estimated duration is unknown — render "–" instead
                      of the fake "00:00:00" (SongCard parity). */}
                  {meta.duration > 0 && !meta.durationEstimated
                    ? formatDuration(meta.duration)
                    : "–"}
                </span>
                <span className="mx-2 text-gray-300 dark:text-gray-600">•</span>
                <span className="text-[11px] font-medium tracking-wide">
                  {formatBytes(meta.size)}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {!selectionMode && (
        <div className="ml-2 shrink-0">
          <MoreMenu
            variant="queue"
            track={track}
            disableRemoveFromQueue={isCurrent}
            onRemoveFromQueue={onRemoveFromQueue}
            onRemoveFolderFromQueue={onRemoveFolderFromQueue}
          />
        </div>
      )}
    </div>
  );

  if (isCurrent) {
    return (
      <div
        data-testid="queue-row"
        aria-current="true"
        className="group w-full rounded-xl cursor-default"
        style={{ height: QUEUE_ROW_HEIGHT }}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      data-testid="queue-row"
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        // Keys pressed inside the row menu must not activate the row.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className="group w-full rounded-xl cursor-pointer"
      style={{ height: QUEUE_ROW_HEIGHT }}
    >
      {content}
    </div>
  );
}
