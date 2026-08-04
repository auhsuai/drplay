import React from "react";

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  rounded?: string;
}

const BASE_CLASS =
  "animate-pulse bg-gray-200 dark:bg-[#3a3b3f] transition-colors duration-300 motion-reduce:animate-none";

const toStyle = (width?: string | number, height?: string | number): React.CSSProperties => {
  const style: React.CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  return style;
};

export function Skeleton({
  width,
  height,
  className = "",
  rounded = "rounded",
}: SkeletonProps) {
  return (
    <div
      className={`${BASE_CLASS} ${rounded} ${className}`}
      style={toStyle(width, height)}
      aria-hidden="true"
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
  lineClassName?: string;
  gap?: string;
}

export function SkeletonText({
  lines = 3,
  className = "",
  lineClassName = "",
  gap = "space-y-2",
}: SkeletonTextProps) {
  return (
    <div className={`${gap} ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={12}
          width={i === lines - 1 ? "60%" : "100%"}
          className={lineClassName}
          rounded="rounded"
        />
      ))}
    </div>
  );
}

export interface SkeletonCardGridProps {
  cols?: number;
  rows?: number;
  className?: string;
}

const CARD_GRID_CLASS = "grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6";

export function SkeletonCardGrid({
  cols = 5,
  rows = 1,
  className = "",
}: SkeletonCardGridProps): React.JSX.Element {
  return (
    <div className={`${CARD_GRID_CLASS} ${className}`} aria-hidden="true">
      {Array.from({ length: rows * cols }).map((_, i) => (
        <div
          key={i}
          data-testid="skeleton-card"
          className="flex flex-col gap-2"
        >
          <Skeleton className="aspect-square w-full rounded-2xl" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-full rounded" />
            <Skeleton className="h-3 w-2/3 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export type SkeletonRowVariant = 'audio' | 'folder' | 'trash';

export interface SkeletonRowListProps {
  rows?: number;
  // Kept for type compatibility only — no caller passes it anymore and it is
  // intentionally not destructured (noUnusedLocals). Row content now follows
  // the `variant` prop instead of the icon flag.
  showFolderIcon?: boolean;
  className?: string;
  // stretch makes the list and its rows flex-fill the available height so the
  // skeleton covers the whole loading region instead of leaving a blank
  // band below a fixed row count. Opt-in: default stays compact.
  stretch?: boolean;
  // Which real list layout the skeleton mirrors. Defaults to 'audio' (MyDrive
  // SongCard rows); 'folder' (FolderSelection card + Home Jump Back In);
  // 'trash' (single-line TrashScreen rows).
  variant?: SkeletonRowVariant;
  // Replaces the default flex column with the REAL list container class of
  // the screen being loaded (e.g. FolderSelection's
  // "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3", Jump Back In's
  // "grid grid-cols-2 md:grid-cols-4 gap-4", Trash's "flex flex-col gap-2")
  // so the skeleton shape matches the loaded list instead of jumping between
  // a 1-column list and a multi-column grid.
  containerClassName?: string;
}

// Row chrome per variant, mirrored from measured real components.
// Padding is p-3/p-4 (ALL four sides) to match the real rows — SongCard p-3,
// FolderSelectionScreen p-4, TrashScreen p-3; a py-* only variant would glue
// the icon to the row's left edge, off from the real list.
// audio:  SongCard.tsx:321-328                p-3 / gap-4 / bg-[#F8F9FA] dark:bg-[#202124] + rounded-xl
// folder: FolderSelectionScreen.tsx:44        p-4 / gap-4 / bg-[#F8F9FA] dark:bg-[#202124] + rounded-xl
//                                              (HomeTab.tsx:269 is p-3.5 rounded-2xl — accepted 2px/2px skew)
// trash:  TrashScreen.tsx:232-235             p-3 / gap-3 / bg-gray-50 dark:bg-[#202124] + rounded-xl
const ROW_CLASS: Record<SkeletonRowVariant, string> = {
  audio: 'flex items-center gap-4 p-3 bg-[#F8F9FA] dark:bg-[#202124] rounded-xl',
  folder: 'flex items-center gap-4 p-4 bg-[#F8F9FA] dark:bg-[#202124] rounded-xl',
  trash: 'flex items-center gap-3 p-3 bg-gray-50 dark:bg-[#202124] rounded-xl',
};

// Icon boxes: SongCard/FolderCard/JumpBackIn use 48px (w-12 h-12),
// TrashScreen uses 40px (w-10 h-10); all rounded-lg. The ring mirrors the
// real icon box boundary — real icons carry their own bg (audio:
// bg-gray-200 dark:bg-[#121212] SongCard:339; folder: bg-amber-100
// dark:bg-amber-900/30 FolderSelectionScreen:46; trash: bg-[#4285F4]/10
// TrashScreen:256), skeletons have none, so the faint border keeps the
// icon vs text boundary visible.
const ROW_ICON_CLASS: Record<SkeletonRowVariant, string> = {
  audio: 'w-12 h-12 rounded-lg shrink-0 ring-1 ring-black/5 dark:ring-white/10',
  folder: 'w-12 h-12 rounded-lg shrink-0 ring-1 ring-black/5 dark:ring-white/10',
  trash: 'w-10 h-10 rounded-lg shrink-0 ring-1 ring-black/5 dark:ring-white/10',
};

// Title line maps to the real text size (15px → h-4, 14px → h-3.5); sub line
// is 13px (h-3). The 4px title/sub gap (SongCard mb-0.5 + mt-0.5) → space-y-1.
const TITLE_LINE_CLASS: Record<SkeletonRowVariant, string> = {
  audio: 'h-4 w-3/4 rounded',
  folder: 'h-4 w-3/4 rounded',
  trash: 'h-3.5 w-1/2 rounded',
};

export function SkeletonRowList({
  rows = 8,
  className = "",
  stretch = false,
  variant = 'audio',
  containerClassName,
}: SkeletonRowListProps): React.JSX.Element {
  const lineClasses = variant === 'trash'
    ? [TITLE_LINE_CLASS[variant]]
    : [TITLE_LINE_CLASS[variant], 'h-3 w-1/3 rounded'];
  // Default container mirrors the MyDrive list (VirtualizedSongList wraps
  // every row in pb-3 = 12px gap); screens with a different real layout pass
  // containerClassName (grid columns / other gaps).
  const containerClass = containerClassName ?? `flex flex-col gap-3${stretch ? ' h-full' : ''}`;
  return (
    <div className={`${containerClass} ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          data-testid="skeleton-row"
          className={`${ROW_CLASS[variant]}${stretch ? ' flex-1' : ''}`}
        >
          <Skeleton className={ROW_ICON_CLASS[variant]} />
          <div className={`flex-1 min-w-0${variant === 'trash' ? '' : ' space-y-1'}`}>
            {lineClasses.map((lineClass, j) => (
              <Skeleton key={j} className={lineClass} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
