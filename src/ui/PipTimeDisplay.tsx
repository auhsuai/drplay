import { formatTime } from "../utils/formatTime";

const TIME_DISPLAY_CLASS =
  "shrink-0 whitespace-nowrap text-sm text-white/80 tabular-nums";

export interface PipTimeDisplayProps {
  currentTime: number;
  duration: number;
  className?: string;
}

/**
 * The PiP window's ONE time read-out: `current / total`.
 *
 * The full-screen bar splits this job between `VideoTimeDisplay` (which owns a
 * 4/s engine subscription the PiP window cannot have) and the seek bar's two
 * flanking clocks. The PiP view already receives `currentTime`/`duration` on
 * every `pip-state` push, so a leaf that just formats two numbers is enough —
 * and dropping the flanking clocks leaves exactly one place to read the time,
 * matching the fullscreen layout.
 */
export function PipTimeDisplay({
  currentTime,
  duration,
  className = "",
}: PipTimeDisplayProps) {
  return (
    <span
      data-testid="pip-time-display"
      className={`${TIME_DISPLAY_CLASS} ${className}`.trim()}
    >
      {formatTime(currentTime)} /{" "}
      {duration > 0 ? formatTime(duration) : "--:--"}
    </span>
  );
}
