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
// rounded-r-full: the segment's right end (its tail) must match the seek
// bar's rounded progress fill when the buffer ends mid-track.
const BUFFER_SEGMENT_BG = "bg-gray-400 dark:bg-gray-500 rounded-r-full";

/**
 * Render the buffered ranges around the playhead as individual
 * absolutely-positioned segments inside `container`.
 *
 * Only the range CONTAINING the playhead (start <= currentTime < end) is
 * drawn, clipped to `currentTime`. After a seek the media element keeps the
 * pre-seek ranges in memory — seeking back to 7:00 still leaves e.g.
 * [12:00,12:30] in `buffered` — so:
 * - ranges fully in the past (end <= currentTime) are dropped (already played);
 * - ranges fully ahead of the playhead (start > currentTime) are ALSO dropped:
 *   they are stale pre-seek cache. Playback re-buffers from the new position,
 *   so drawing them would show a phantom segment at the old spot instead of
 *   the buffer at the new one (YouTube/Spotify behaviour).
 *
 * Only touches the DOM when needed — child <div>s are created/removed to match
 * the number of VISIBLE segments and repositioned on each call. No React
 * re-render.
 */
export function updateBufferBar(
  container: HTMLElement | null,
  source: BufferedSource,
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
  const hasPlayhead = Number.isFinite(source.currentTime);
  const currentTime = hasPlayhead ? source.currentTime : 0;

  // Keep only the range containing the playhead. Ranges fully in the past
  // (end <= currentTime) are already-played buffer; ranges fully ahead
  // (start > currentTime) are stale cache left in memory by a previous seek —
  // both are dropped so the bar never shows a phantom segment at an old
  // position after seeking backwards.
  const visible: Array<[number, number]> = [];
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (end <= currentTime) continue;
    if (hasPlayhead && start > currentTime) continue;
    visible.push([Math.max(start, currentTime), end]);
  }

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
    const left = (start / dur) * 100;
    const width = ((end - start) / dur) * 100;
    seg.style.left = `${String(left)}%`;
    seg.style.width = `${String(width)}%`;
  }
}

/** Clear all buffer segments inside `container` (e.g. on track switch). */
export function clearBufferBar(container: HTMLElement | null): void {
  if (container && container.childElementCount > 0) container.innerHTML = "";
}
