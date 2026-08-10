import { useTranslation } from "react-i18next";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

export interface SeekRailProps {
  progressBarRef: RefObject<HTMLDivElement | null>;
  bufferFillRef: RefObject<HTMLDivElement | null>;
  progressFillRef: RefObject<HTMLDivElement | null>;
  tooltipRef: RefObject<HTMLDivElement | null>;
  bufferPreviewRef: RefObject<HTMLDivElement | null>;
  isHovering: boolean;
  isDragging: boolean;
  duration: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerEnter: () => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
}

export function SeekRail({
  progressBarRef,
  bufferFillRef,
  progressFillRef,
  tooltipRef,
  bufferPreviewRef,
  isHovering,
  isDragging,
  duration,
  onPointerDown,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
}: SeekRailProps) {
  const { t } = useTranslation();

  return (
    <div
      ref={progressBarRef}
      role="progressbar"
      aria-label={t("now_playing.progress")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <div
        ref={bufferFillRef}
        data-testid="buffer-fill"
        className="absolute inset-0 overflow-hidden rounded-full pointer-events-none"
      ></div>
      {isHovering && (
        <div
          ref={bufferPreviewRef}
          data-testid="buffer-preview"
          className="absolute top-0 left-0 h-full bg-gray-400 dark:bg-gray-500 rounded-r-sm pointer-events-none"
          style={{ left: "0%", width: "0%" }}
        ></div>
      )}
      <div
        ref={progressFillRef}
        data-testid="progress-fill"
        className="absolute left-0 h-full bg-brand-primary rounded-full flex items-center transform-gpu will-change-[width]"
      >
        <div
          data-testid="seek-thumb"
          className={`absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0 pointer-events-none transition-opacity ${
            isHovering || isDragging ? "opacity-100" : "opacity-0"
          }`}
        ></div>
      </div>
      {isHovering && duration > 0 && (
        <div
          ref={tooltipRef}
          data-testid="seek-tooltip"
          className="absolute bottom-full mb-2 left-0 -translate-x-1/2 z-10 px-2 py-1 rounded bg-gray-800 text-white text-xs whitespace-nowrap tabular-nums shadow pointer-events-none select-none"
        >
          0:00
        </div>
      )}
    </div>
  );
}
