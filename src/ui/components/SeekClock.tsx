import type { RefObject } from "react";

export interface SeekClockProps {
  timeTextRef: RefObject<HTMLSpanElement | null>;
  /** "top" hides the span but keeps it mounted: currentTimeTextRef is written
   *  DOM-direct on the timeupdate/drag paths, so the node must exist. */
  variant?: "default" | "top";
}

export function SeekClock({
  timeTextRef,
  variant = "default",
}: SeekClockProps) {
  return (
    <span
      ref={timeTextRef}
      className={`text-xs text-gray-500 min-w-[52px] text-right tabular-nums${
        variant === "top" ? " hidden" : ""
      }`}
    >
      0:00
    </span>
  );
}
