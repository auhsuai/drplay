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
