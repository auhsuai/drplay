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
const BUFFER_SEGMENT_BG = 'bg-gray-400 dark:bg-gray-500';

/**
 * Render the buffered ranges that lie AHEAD of the playhead as individual
 * absolutely-positioned segments inside `container`.
 *
 * Only the FUTURE part of each TimeRange is drawn: after a backward seek the
 * media element still reports the full pre-seek range in `buffered` (in-memory
 * cache), so clipping to `currentTime` is what makes the bar actually shrink
 * to the remaining buffer (YouTube/Spotify behaviour). Fully-past ranges are
 * dropped instead of rendered. Forward-seek non-contiguous ranges are still
 * reflected accurately (each range rendered at its own position).
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
  if (!isFinite(dur) || dur <= 0 || !buffered || buffered.length === 0) {
    if (container.childElementCount > 0) container.innerHTML = '';
    return;
  }

  // A non-finite playhead (metadata race) would poison the clipping math with
  // NaN percentages — fall back to 0 so the full ranges render like before.
  const currentTime = Number.isFinite(source.currentTime) ? source.currentTime : 0;

  // Clip each range to the future part; drop ranges fully in the past so the
  // bar never shows already-played buffer after a backward seek.
  const visible: Array<[number, number]> = [];
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (end <= currentTime) continue;
    visible.push([Math.max(start, currentTime), end]);
  }

  // Sync the number of segment <div>s to the number of VISIBLE ranges — the
  // raw buffered.length may exceed it when past ranges were dropped.
  while (container.childElementCount < visible.length) {
    const seg = document.createElement('div');
    seg.className = BUFFER_SEGMENT_BG;
    seg.style.position = 'absolute';
    seg.style.top = '0';
    seg.style.height = '100%';
    seg.style.pointerEvents = 'none';
    container.appendChild(seg);
  }
  while (container.childElementCount > visible.length) {
    const last = container.lastElementChild;
    if (last) container.removeChild(last);
  }

  for (let i = 0; i < visible.length; i++) {
    const [start, end] = visible[i];
    const seg = container.children[i] as HTMLElement;
    const left = (start / dur) * 100;
    const width = ((end - start) / dur) * 100;
    seg.style.left = `${left}%`;
    seg.style.width = `${width}%`;
  }
}

/** Clear all buffer segments inside `container` (e.g. on track switch). */
export function clearBufferBar(container: HTMLElement | null): void {
  if (container && container.childElementCount > 0) container.innerHTML = '';
}
