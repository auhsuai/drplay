export interface BufferedRangePct {
  /** start of the buffered segment, as a percentage 0-100 */
  left: number;
  /** size of the buffered segment, as a percentage 0-100 */
  width: number;
}

/**
 * Compute the buffered segment to display, positioned accurately.
 *
 * Returns the buffered TimeRange that contains `audio.currentTime`, so the
 * bar reflects the real buffered region (which may start anywhere, e.g. after
 * a forward seek creates a non-contiguous range). If the playhead is in a gap
 * (just seeked to an unbuffered position while the browser is fetching), falls
 * back to the nearest buffered range (preferring the upcoming one).
 *
 * Returns null when there is no usable buffered data.
 */
export function getBufferedRangePct(audio: HTMLMediaElement): BufferedRangePct | null {
  const dur = audio.duration;
  const buffered = audio.buffered;
  if (!isFinite(dur) || dur <= 0 || !buffered || buffered.length === 0) return null;

  const t = audio.currentTime;

  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (t >= start && t <= end) {
      return { left: (start / dur) * 100, width: ((end - start) / dur) * 100 };
    }
  }

  // Playhead sits in a gap (e.g. just after a forward seek). Use the nearest
  // range so the bar still shows something meaningful instead of vanishing.
  let best: { start: number; end: number; dist: number } | null = null;
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    const dist = start > t ? start - t : t - end;
    if (!best || dist < best.dist) best = { start, end, dist };
  }
  if (best) {
    return { left: (best.start / dur) * 100, width: ((best.end - best.start) / dur) * 100 };
  }
  return null;
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
 * Unlike getBufferedRangePct (which collapses to a single range containing the
 * playhead), this shows EVERY buffered TimeRange, so a forward seek that
 * creates a non-contiguous range is reflected accurately: the old buffered
 * region stays visible AND the new one appears at the seek position. This
 * matches the industry-standard multi-segment buffer bar (YouTube/Vimeo, MDN).
 *
 * Only touches the DOM when needed — child <div>s are created/removed to match
 * buffered.length and repositioned on each call. No React re-render.
 */
export function updateBufferBar(
  container: HTMLElement | null,
  audio: HTMLMediaElement,
): void {
  if (!container) return;

  const dur = audio.duration;
  const buffered = audio.buffered;
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
