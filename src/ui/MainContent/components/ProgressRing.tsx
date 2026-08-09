import React from "react";

// Determinate upload ring (replaces the old centered spinner): 24-unit
// viewBox, stroke 2, radius 10 keeps the stroke fully inside the box
// (radius = center - stroke per the CSS-Tricks progress-ring pattern).
const RING_VIEWBOX = "0 0 24 24";
const RING_CENTER = 12;
const RING_RADIUS = 10;
const RING_STROKE_WIDTH = 2;
// dashoffset = C × (1 − fraction) draws the visible arc; the -90° rotation
// makes it start at 12 o'clock instead of the default 3 o'clock.
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_ROTATION = "rotate(-90 12 12)";
const PROGRESS_MIN = 0;
const PROGRESS_MAX = 1;

// Progress fractions can overshoot (Drive confirms bytes out of order) — clamp
// to a valid arc; undefined/NaN (no progress reported yet) mean "just started".
export function ProgressRing({
  fraction,
}: {
  fraction: number | undefined;
}): React.JSX.Element {
  const clamped =
    fraction === undefined || !Number.isFinite(fraction)
      ? PROGRESS_MIN
      : Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, fraction));
  const percent = Math.round(clamped * 100);
  return (
    <svg
      className="w-5 h-5 shrink-0"
      viewBox={RING_VIEWBOX}
      role="img"
      // The % is announced to screen readers only — the ring itself stays a
      // pure arc (user design: no number inside the ring next to the title).
      aria-label={`${String(percent)}%`}
    >
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE_WIDTH}
        className="stroke-gray-200 dark:stroke-[#3c4043]"
      />
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped)}
        transform={RING_ROTATION}
        className="stroke-brand-primary"
      />
    </svg>
  );
}
