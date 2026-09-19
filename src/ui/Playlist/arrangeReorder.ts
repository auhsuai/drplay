import type { Track } from "../../types";

/**
 * Fixed row height used by PlaylistView's virtualizer (estimateSize + row
 * style). Drag/indicator math must use the same constant: rows are never
 * measured (no measureElement), so coordinates are deterministic.
 */
export const PLAYLIST_ROW_HEIGHT = 56;

export interface ArrangeDrop {
  /** Insert index within the remaining (non-selected) items. */
  insertionIndex: number;
  /** Indicator line position, px from the list content top. */
  indicatorY: number;
}

interface ArrangePartition {
  /** Selected tracks in source-array order (the block to move). */
  group: Track[];
  /** Everything else, source-array order preserved. */
  remaining: Track[];
  /** Source index of each remaining item (for row-position math). */
  remainingIndexes: number[];
}

/**
 * Splits the playlist into the dragged group and the remaining items. The
 * group order is ALWAYS the source-array order — never the click/drag order
 * (§8.3) — and ids absent from the list are ignored (a stale selection from
 * an older reload must not inject ghost rows).
 */
function partitionArrange(
  tracks: readonly Track[],
  selectedIds: ReadonlySet<string>,
): ArrangePartition {
  const group: Track[] = [];
  const remaining: Track[] = [];
  const remainingIndexes: number[] = [];
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (track === undefined) continue;
    if (selectedIds.has(track.id)) {
      group.push(track);
    } else {
      remaining.push(track);
      remainingIndexes.push(index);
    }
  }
  return { group, remaining, remainingIndexes };
}

const sameOrder = (a: readonly Track[], b: readonly Track[]): boolean =>
  a.length === b.length && a.every((track, index) => track.id === b[index]?.id);

/**
 * Resolves the live insertion position from a pointer position expressed in
 * list content coordinates (pointer clientY minus the list container top).
 *
 * The insertion index is computed on the REMAINING items (the group removed
 * first, §10), so dragging a block down/up can never drift the index (§9.1).
 * Returns null when nothing can move: no selection, select-all, or a
 * 1-item playlist.
 */
export function resolveArrangeDrop(
  tracks: Track[],
  selectedIds: ReadonlySet<string>,
  pointerY: number,
  rowHeight: number = PLAYLIST_ROW_HEIGHT,
): ArrangeDrop | null {
  const { group, remaining, remainingIndexes } = partitionArrange(
    tracks,
    selectedIds,
  );
  if (group.length === 0 || remaining.length === 0) return null;

  let insertionIndex = 0;
  for (let r = 0; r < remaining.length; r += 1) {
    const sourceIndex = remainingIndexes[r];
    if (sourceIndex === undefined) break;
    // First remaining item whose vertical midpoint is below the pointer
    // starts the block; pointer below every midpoint → insert at the end.
    if (sourceIndex * rowHeight + rowHeight / 2 < pointerY)
      insertionIndex = r + 1;
    else break;
  }

  const nextRemaining = remainingIndexes[insertionIndex];
  const lastRemaining = remainingIndexes[remaining.length - 1];
  if (lastRemaining === undefined) return null;
  const indicatorY =
    nextRemaining === undefined
      ? (lastRemaining + 1) * rowHeight
      : nextRemaining * rowHeight;

  return { insertionIndex, indicatorY };
}

/**
 * Applies a drop: remaining items in order with the group spliced in at
 * `insertionIndex`. Returns the SAME array reference when the resulting order
 * equals the current one (drop inside the group's own region, §9.2 → the
 * caller must skip persist + mutation), otherwise a new array. Never mutates
 * the input and never clones track objects (§21).
 */
export function applyArrangeDrop(
  tracks: Track[],
  selectedIds: ReadonlySet<string>,
  insertionIndex: number,
): Track[] {
  const { group, remaining } = partitionArrange(tracks, selectedIds);
  if (group.length === 0 || remaining.length === 0) return tracks;
  const at = Math.min(Math.max(insertionIndex, 0), remaining.length);
  const next = [...remaining.slice(0, at), ...group, ...remaining.slice(at)];
  return sameOrder(tracks, next) ? tracks : next;
}
