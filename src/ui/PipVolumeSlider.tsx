import { useEffect, useRef, useState } from "react";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface PipVolumeSliderProps {
  /** Engine volume, 0..1, mirrored from `pip-state`. */
  volume: number;
  isMuted: boolean;
  /** Reports the dragged level; the caller forwards it as `setVolume`. */
  onVolumeChange: (value: number) => void;
  /** The caller forwards this as `toggleMute`. */
  onToggleMute: () => void;
  /** Hides the rail (compact row) while keeping the mute button. */
  hideRail?: boolean;
  className?: string;
}

/**
 * Volume control for the PiP window.
 *
 * Presentational by contract, like `PipSeekBar`: the PiP window has no engine,
 * so this component owns no volume/mute state — it only knows whether a finger
 * is currently down on its rail (pure visual feedback) and reports every level
 * through `onVolumeChange`. The main window remains the single source of truth.
 *
 * The rail is the PlayerBar `VolumeSlider`'s look ported verbatim (same
 * classes, same icon ladder, same drag math) so the two surfaces stay one
 * design. Two deliberate differences:
 *  - `flex` instead of `hidden xl:flex`: the PiP window is never wide enough for
 *    the `xl` breakpoint, so gating would hide the rail forever.
 *  - The mute affordance is a real `<button>`. The shared copy draws a bare
 *    `<svg onClick>`, which no keyboard user can reach; that a11y bug is not
 *    worth inheriting in a new component.
 */
export function PipVolumeSlider({
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  hideRail = false,
  className = "",
}: PipVolumeSliderProps) {
  const { t } = useTranslation();
  // Render-only mirror of "a drag is live": it drives the hover-independent
  // fill/thumb highlight. The authoritative session guard is the owner
  // pointerId captured in the pointerdown closure below.
  const [isVolumeActive, setIsVolumeActive] = useState(false);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  // Window handlers are mirrored into refs so the unmount cleanup can remove
  // them even when the PiP window closes mid-drag — otherwise the listeners
  // outlive the component and keep calling setState on a dead tree.
  const dragMoveRef = useRef<(event: PointerEvent) => void>(() => undefined);
  const dragFinishRef = useRef<(event: PointerEvent) => void>(() => undefined);

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", dragMoveRef.current);
      window.removeEventListener("pointerup", dragFinishRef.current);
      window.removeEventListener("pointercancel", dragFinishRef.current);
    },
    [],
  );

  const handlePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    const bar = volumeBarRef.current;
    if (bar === null) return;
    const bounds = bar.getBoundingClientRect();
    // Degenerate geometry (no layout yet, collapsed window): dividing by
    // bounds.width would produce Infinity/NaN, i.e. a garbage volume. Report
    // nothing and start no session.
    if (bounds.width <= 0) return;

    // Single-owner drag: the window listeners below receive every pointer's
    // events, so a second finger must not be able to drive (or end) this drag.
    const ownerPointerId = event.pointerId;

    const updateVolume = (clientX: number): void => {
      const percent = Math.min(
        1,
        Math.max(0, (clientX - bounds.left) / bounds.width),
      );
      onVolumeChange(percent);
    };

    updateVolume(event.clientX);
    setIsVolumeActive(true);

    let sessionDone = false;
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== ownerPointerId) return;
      updateVolume(moveEvent.clientX);
    };
    const endSession = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== ownerPointerId) return;
      if (sessionDone) return;
      sessionDone = true;
      setIsVolumeActive(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endSession);
      window.removeEventListener("pointercancel", endSession);
    };

    dragMoveRef.current = onMove;
    dragFinishRef.current = endSession;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endSession);
    window.addEventListener("pointercancel", endSession);
  };

  // A muted track has no audible level: the fill reads 0 even though `volume`
  // keeps the value to restore on unmute (same rule as the PlayerBar slider).
  const volumePercent = isMuted ? 0 : volume * 100;
  const VolumeIcon =
    isMuted || volume === 0
      ? VolumeX
      : volume < 0.33
        ? Volume
        : volume < 0.66
          ? Volume1
          : Volume2;

  return (
    <div className={`flex min-w-0 items-center gap-2 ${className}`.trim()}>
      <button
        type="button"
        onClick={onToggleMute}
        aria-label={isMuted ? t("player.pip.unmute") : t("player.pip.mute")}
        title={isMuted ? t("player.pip.unmute") : t("player.pip.mute")}
        className="shrink-0 text-gray-500 transition-colors hover:text-white"
      >
        <VolumeIcon className="h-6 w-6" />
      </button>
      {!hideRail && (
        <div
          ref={volumeBarRef}
          data-testid="pip-volume-bar"
          className="flex h-1.5 w-[125px] cursor-pointer items-center rounded-full bg-gray-200 group relative dark:bg-[#2A2A2A]"
          onPointerDown={handlePointerDown}
        >
          <div
            data-testid="pip-volume-fill"
            className={`absolute left-0 h-full rounded-full bg-gray-500 transition-colors group-hover:bg-brand-primary dark:bg-gray-400 ${
              isVolumeActive ? "!bg-brand-primary" : ""
            }`}
            style={{ width: `${String(volumePercent)}%` }}
          >
            <div
              className={`absolute right-0 top-1/2 h-3 w-3 shrink-0 -translate-y-1/2 translate-x-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100 ${
                isVolumeActive ? "!opacity-100" : ""
              }`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
