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
 * Render the FULL set of buffered ranges as individual absolutely-positioned
 * segments inside `container`.
 *
 * Shows EVERY buffered TimeRange, so a forward seek that creates a
 * non-contiguous range is reflected accurately: the old buffered region stays
 * visible AND the new one appears at the seek position. This matches the
 * industry-standard multi-segment buffer bar (YouTube/Vimeo, MDN).
 *
 * Only touches the DOM when needed — child <div>s are created/removed to match
 * buffered.length and repositioned on each call. No React re-render.
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

  const count = buffered.length;

  // Sync the number of segment <div>s to the number of buffered ranges.
  while (container.childElementCount < count) {
    const seg = document.createElement('div');
    seg.className = BUFFER_SEGMENT_BG;
    seg.style.position = 'absolute';
    seg.style.top = '0';
    seg.style.height = '100%';
    seg.style.pointerEvents = 'none';
    container.appendChild(seg);
  }
  while (container.childElementCount > count) {
    const last = container.lastElementChild;
    if (last) container.removeChild(last);
  }

  for (let i = 0; i < count; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
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
