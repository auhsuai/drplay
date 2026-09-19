import { useCallback, useEffect, useRef, useState } from "react";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { AudioController } from "../../lib/AudioController";

const VOLUME_STEP = 0.1;

export interface VolumeSliderProps {
  audio: AudioController;
  /** Optional control rendered left of the volume icon (e.g. the queue button). */
  leading?: React.ReactNode;
}

export function VolumeSlider({ audio, leading }: VolumeSliderProps) {
  // Volume UI state is owned here: it only feeds this component's icon +
  // bar width, so updates stay local instead of re-rendering the whole
  // PlayerBar tree (render-critical isolation).
  // Rehydrate from the engine (source of truth): release() keeps the engine's
  // volume/mute, so a remount (logout→login) must show the engine's current
  // level, not the 1/false defaults (D3/R1.4).
  const [volume, setVolume] = useState(() => audio.getVolume());
  const [isMuted, setIsMuted] = useState(() => audio.isMuted());
  const [isVolumeActive, setIsVolumeActive] = useState(false);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  // Window drag handlers are mirrored into refs so the unmount cleanup below
  // can remove them even mid-drag (same contract as useSeekDrag).
  const dragMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const dragFinishRef = useRef<(e: PointerEvent) => void>(() => {});

  const toggleMute = useCallback(() => {
    setIsMuted(AudioController.getInstance().toggleMute());
  }, []);

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", dragMoveRef.current);
      window.removeEventListener("pointerup", dragFinishRef.current);
      window.removeEventListener("pointercancel", dragFinishRef.current);
    },
    [],
  );

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeBarRef.current) return;
    const bounds = volumeBarRef.current.getBoundingClientRect();
    // Single-owner drag: the window listeners receive every pointer's events,
    // so a second finger must not be able to drive (or end) this drag.
    const ownerPointerId = e.pointerId;

    const updateVol = (clientX: number) => {
      const percent = Math.max(
        0,
        Math.min(1, (clientX - bounds.left) / bounds.width),
      );
      setVolume(percent);
      // Engine is the source of truth for mute: setting a non-zero level while
      // muted must unmute the engine too, or the UI shows audio while playback
      // stays silent. isMuted() flips after the toggle, so later moves in the
      // same drag do not toggle again.
      if (percent > 0 && audio.isMuted()) audio.toggleMute();
      audio.setVolume(percent);
      if (percent > 0) setIsMuted(false);
      setIsVolumeActive(true);
    };

    updateVol(e.clientX);

    let sessionDone = false;
    const endSession = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== ownerPointerId) return;
      if (sessionDone) return;
      sessionDone = true;
      setIsVolumeActive(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endSession);
      window.removeEventListener("pointercancel", endSession);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== ownerPointerId) return;
      updateVol(moveEvent.clientX);
    };

    dragMoveRef.current = onMove;
    dragFinishRef.current = endSession;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endSession);
    window.addEventListener("pointercancel", endSession);
  };

  // ArrowUp/Down nudge the volume, m/M toggles mute. Owned here (not the
  // global shortcuts hook) because they write this component's local state.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl?.tagName === "INPUT" ||
        activeEl?.tagName === "TEXTAREA" ||
        activeEl?.isContentEditable
      )
        return;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setVolume((prev) => {
            const nv = Math.min(1, prev + VOLUME_STEP);
            audio.setVolume(nv);
            return nv;
          });
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume((prev) => {
            const nv = Math.max(0, prev - VOLUME_STEP);
            audio.setVolume(nv);
            return nv;
          });
          break;
        case "m":
        case "M":
          e.preventDefault();
          toggleMute();
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [audio, toggleMute]);

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
    <div className="flex items-center justify-end w-[30%] min-w-[120px] pl-2 gap-3">
      {leading}
      <VolumeIcon
        className="w-6 h-6 text-gray-500 hover:text-white cursor-pointer"
        onClick={toggleMute}
      />
      <div
        ref={volumeBarRef}
        data-testid="volume-bar"
        className="hidden xl:flex w-16 sm:w-32 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer relative group items-center"
        onPointerDown={handleVolumePointerDown}
      >
        <div
          className={`absolute left-0 h-full bg-gray-500 dark:bg-gray-400 group-hover:bg-brand-primary ${isVolumeActive ? "!bg-brand-primary" : ""} rounded-full transition-colors`}
          style={{ width: `${String(volumePercent)}%` }}
        >
          <div
            className={`absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 ${isVolumeActive ? "!opacity-100" : ""} transition-opacity shrink-0`}
          ></div>
        </div>
      </div>
    </div>
  );
}
