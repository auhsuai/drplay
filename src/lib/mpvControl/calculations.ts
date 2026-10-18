/**
 * PURE mpv-control maths — the preset rings, the epsilon compares and the
 * cycle/step helpers. No IPC and no Tauri import: this is the leaf of the
 * mpvControl package, so `ipc.ts` / `tracks.ts` / `videoControls.ts` may all
 * depend on it and it depends on nothing but the track shape.
 */

import type { MpvTrack } from "./tracks";

export const ASPECT_AUTO = -2;
export const ASPECT_NO = -1;

/**
 * Aspect presets in cycle order (mpv `video-aspect-override` values: -2 auto,
 * -1 no override; 1 = square). Epsilon compare: mpv echoes back rounded floats
 * (16/9 comes back as 1.777778).
 */
const ASPECT_PRESETS: readonly number[] = [
  ASPECT_AUTO,
  16 / 9,
  4 / 3,
  21 / 9,
  1,
];
const ASPECT_EPSILON = 1e-3;

/** Playback-speed ladder (mpv `speed`), clamped at both ends. */
const SPEED_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const SPEED_NORMAL = 1;

const RATIO_EPSILON = 1e-3;

/**
 * Next/previous track id inside an already type-filtered track list.
 * Wraps around; ≤1 track is a no-op (null); a current id missing from the
 * list (or null) starts at the first/last entry for the given direction.
 */
export function nextTrackId(
  tracks: readonly MpvTrack[],
  currentId: number | null,
  direction: 1 | -1,
): number | null {
  if (tracks.length <= 1) return null;
  const fallback = direction === 1 ? tracks[0] : tracks[tracks.length - 1];
  if (currentId === null) return fallback?.id ?? null;
  const index = tracks.findIndex((track) => track.id === currentId);
  if (index === -1) return fallback?.id ?? null;
  const next = tracks[(index + direction + tracks.length) % tracks.length];
  return next?.id ?? null;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < ASPECT_EPSILON;
}

/**
 * Cycle the fixed aspect preset ring: -2 auto → 16/9 → 4/3 → 21/9 → 1 → -2.
 * An unknown current value (including -1 "no override") restarts the ring at
 * auto. Values were narrowed by getAspectOverride, so only the ring matters.
 */
export function aspectCycleValue(current: number): number {
  const index = ASPECT_PRESETS.findIndex((preset) =>
    nearlyEqual(preset, current),
  );
  if (index === -1) return ASPECT_PRESETS[0] ?? ASPECT_AUTO;
  return ASPECT_PRESETS[(index + 1) % ASPECT_PRESETS.length] ?? ASPECT_AUTO;
}

const DEINTERLACE_CYCLE: Record<string, "no" | "auto" | "yes"> = {
  no: "auto",
  auto: "yes",
  yes: "no",
};

export function deinterlaceCycle(current: string): "no" | "auto" | "yes" {
  return DEINTERLACE_CYCLE[current] ?? "no";
}

/**
 * Centered crop rect for the given target ratio, mpv `video-crop` syntax
 * "WxH+X+Y". A source already at the target ratio yields the full rect.
 */
export function cropRectFor(
  width: number,
  height: number,
  ratio: number,
): string {
  if (width <= 0 || height <= 0 || ratio <= 0) return "";
  const sourceRatio = width / height;
  if (Math.abs(sourceRatio - ratio) < RATIO_EPSILON) {
    return `${String(width)}x${String(height)}+0+0`;
  }
  if (sourceRatio > ratio) {
    const cropWidth = Math.round(height * ratio);
    const x = Math.round((width - cropWidth) / 2);
    return `${String(cropWidth)}x${String(height)}+${String(x)}+0`;
  }
  const cropHeight = Math.round(width / ratio);
  const y = Math.round((height - cropHeight) / 2);
  return `${String(width)}x${String(cropHeight)}+0+${String(y)}`;
}

/** Step the speed ladder towards `direction`, clamped to 0.5..2. */
export function speedStep(current: number, direction: 1 | -1): number {
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < SPEED_PRESETS.length; i++) {
    const preset = SPEED_PRESETS[i];
    if (preset === undefined) continue;
    const distance = Math.abs(preset - current);
    if (distance < best) {
      best = distance;
      index = i;
    }
  }
  const next = Math.min(
    Math.max(index + direction, 0),
    SPEED_PRESETS.length - 1,
  );
  return SPEED_PRESETS[next] ?? SPEED_NORMAL;
}
