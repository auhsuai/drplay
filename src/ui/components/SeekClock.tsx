import type { RefObject } from "react";

export interface SeekClockProps {
  timeTextRef: RefObject<HTMLSpanElement | null>;
}

export function SeekClock({ timeTextRef }: SeekClockProps) {
  return (
    <span
      ref={timeTextRef}
      className="text-xs text-gray-500 min-w-[52px] text-right tabular-nums"
    >
      0:00
    </span>
  );
}
