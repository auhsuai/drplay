import type { RefObject } from "react";
import { formatTime } from "../../utils/formatTime";

export interface SeekClockProps {
  timeTextRef: RefObject<HTMLSpanElement | null>;
  duration: number;
}

export function SeekClock({ timeTextRef, duration }: SeekClockProps) {
  return (
    <>
      <span
        ref={timeTextRef}
        className="text-xs text-gray-500 min-w-[52px] text-right tabular-nums"
      >
        0:00
      </span>
      <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">
        {formatTime(duration)}
      </span>
    </>
  );
}
