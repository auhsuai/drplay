/**
 * Minimal shape needed to compute buffered segments. `HTMLMediaElement`
 * satisfies it structurally; tests can pass a plain object.
 */
export interface BufferedSource {
  duration: number;
  currentTime: number;
  buffered: TimeRanges;
}

// Background classes already exist in the Tailwind build (used by the buffer
// bar in PlayerBar/NowPlaying), so referencing them here keeps dynamic
// segments styled without extra CSS. Positioning is done via inline styles to
// stay robust regardless of Tailwind purging.
// rounded-r-sm: the segment head (left edge) is deliberately FLAT ("negative"
// head) — a convex left cap at the playhead would butt against the blue
// fill's round right cap, two semicircles touching at a single point and
// leaving a lens-shaped gap of bare rail above/below the seam. Only the fill
// carries a convex cap at the seam. When the range starts at 0 the container's
// own overflow-hidden rounded-full clip rounds the flat left edge to match
// the rail, so the segment needs no left rounding of its own. The right end
// keeps only a small 2px corner (rounded-r-sm) — a full round cap on a
// mid-track buffer end would look like a "dot" floating on the rail instead
// of a continuous buffer run.
const BUFFER_SEGMENT_BG = "bg-gray-400 dark:bg-gray-500 rounded-r-sm";

// Negative-head pad: the segment starts this fraction of the duration BEFORE
// the playhead (clamped to 0) so its flat left edge tucks UNDER the fill's
// round right cap — the fill (drawn above the buffer layer) covers the
// overlap, guaranteeing the rail never shows around the fill cap at the
// seam, even when a buffered range starts exactly at the playhead (right
// after a seek). 2% of the track duration is several bar-pixels on any
// realistic bar width, comfortably deeper than the ~3px cap radius.
// Exported so the hover buffer-preview (useSeekHover) shares the exact same
// seam geometry instead of drifting apart.
export const BUFFER_HEAD_PAD_PCT = 2;

/**
 * Render the buffered ranges as individual absolutely-positioned segments
 * inside `container`.
 *
 * Each range is drawn IN FULL — from its own start to its end, NOT left-clipped
 * at the playhead — with a NEGATIVE head: the segment start is pulled back to
 * at most `playhead - 2%` so its flat left edge hides under the blue fill
 * (drawn on top). This is the Spotify/YouTube pattern: the buffer layer sits
 * BELOW the fill, so the fill covers the pre-playhead part of the segment and
 * the seam shows exactly ONE convex cap — the fill's. Two round caps touching
 * at a single point (the old behavior when a range started exactly at the
 * playhead) would leave the rail showing through above/below the seam.
 *
 * After a seek the media element keeps the pre-seek ranges in memory —
 * seeking back to 7:00 still leaves e.g. [12:00,12:30] in `buffered` — so:
 * - ranges fully in the past (end <= currentTime) are dropped (already played);
 * - ranges fully ahead of the playhead (start > currentTime) are ALSO dropped:
 *   they are stale pre-seek cache. Playback re-buffers from the new position,
 *   so drawing them would show a phantom segment at the old spot instead of
 *   the buffer at the new one (YouTube/Spotify behaviour).
 *
 * `playheadSeconds` overrides `source.currentTime` for ALL playhead math
 * (the drop checks above and the negative-head pad). Callers pass the UI
 * playhead — the position the blue fill is CURRENTLY showing — because the
 * fill is drawn from throttled `timeupdate` events (~200ms apart) while
 * `getBuffered().currentTime` is the raw, unthrottled media clock. During
 * playback the raw clock runs ~200ms ahead of the fill; using it for the
 * drop checks could judge a range that starts between the fill and the raw
 * clock as "ahead of the playhead" and drop it. When omitted the raw clock
 * is used (e.g. a native `progress` redraw with no UI playhead context).
 *
 * Only touches the DOM when needed — child <div>s are created/removed to match
 * the number of VISIBLE segments and repositioned on each call. No React
 * re-render.
 */
export function updateBufferBar(
  container: HTMLElement | null,
  source: BufferedSource,
  playheadSeconds?: number,
): void {
  if (!container) return;

  const dur = source.duration;
  const buffered = source.buffered;
  if (!Number.isFinite(dur) || dur <= 0 || buffered.length === 0) {
    if (container.childElementCount > 0) container.innerHTML = "";
    return;
  }

  // A non-finite playhead (metadata race) would poison the clipping math with
  // NaN percentages — fall back to 0 so ranges render like before. Without a
  // real playhead there is no "stale pre-seek cache" to drop either, so the
  // separated-ahead filter below only applies when currentTime is known.
  const playhead = playheadSeconds ?? source.currentTime;
  const hasPlayhead = Number.isFinite(playhead);
  const currentTime = hasPlayhead ? playhead : 0;

  // Keep only ranges overlapping the playhead: ranges fully in the past
  // (end <= currentTime) are already-played buffer; ranges fully ahead
  // (start > currentTime) are stale cache left in memory by a previous seek —
  // both are dropped so the bar never shows a phantom segment at an old
  // position after seeking backwards. Surviving ranges render IN FULL (from
  // their own start, pulled back to playhead - 2% — see below): the blue
  // fill, drawn above the buffer layer, covers the pre-playhead part, so the
  // segment's flat head reaches the playhead from BELOW the fill — the fill's
  // small convex right cap meets it flush, no second cap at the seam.
  const visible: Array<[number, number]> = [];
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (end <= currentTime) continue;
    if (hasPlayhead && start > currentTime) continue;
    visible.push([start, end]);
  }

  // Negative-head pad, evaluated once: how far (in seconds) before the
  // playhead the segment head may be pulled back. Without a finite playhead
  // there is no seam to protect — segments keep their own start untouched.
  const padSeconds = hasPlayhead ? (BUFFER_HEAD_PAD_PCT / 100) * dur : 0;

  // Sync the number of segment <div>s to the number of VISIBLE ranges — the
  // raw buffered.length may exceed it when past ranges were dropped.
  while (container.childElementCount < visible.length) {
    const seg = document.createElement("div");
    seg.className = BUFFER_SEGMENT_BG;
    seg.style.position = "absolute";
    seg.style.top = "0";
    seg.style.height = "100%";
    seg.style.pointerEvents = "none";
    container.appendChild(seg);
  }
  while (container.childElementCount > visible.length) {
    const last = container.lastElementChild;
    if (last) container.removeChild(last);
  }

  for (let i = 0; i < visible.length; i++) {
    const range = visible[i];
    if (range === undefined) continue;
    const [start, end] = range;
    const seg = container.children[i] as HTMLElement;
    // Negative head: pull the segment start back to at most playhead - 2%
    // (clamped to the rail start) so the flat left edge hides under the
    // fill's convex right cap — the seam shows a single convex cap (the
    // fill's) instead of two opposing semicircles leaving a lens gap. Ranges
    // already starting before playhead - 2% are untouched (min keeps their
    // own start). The fill (drawn above) covers the overlap; the extra width
    // is invisible but guarantees the rail cannot peek around the cap.
    // Without a finite playhead there is no seam to protect (and no fill
    // position to align with) — keep the range's own start.
    const segStart = hasPlayhead
      ? Math.min(start, Math.max(0, currentTime - padSeconds))
      : start;
    const left = (segStart / dur) * 100;
    const width = ((end - segStart) / dur) * 100;
    seg.style.left = `${String(left)}%`;
    seg.style.width = `${String(width)}%`;
  }
}

/** Clear all buffer segments inside `container` (e.g. on track switch). */
export function clearBufferBar(container: HTMLElement | null): void {
  if (container && container.childElementCount > 0) container.innerHTML = "";
}
