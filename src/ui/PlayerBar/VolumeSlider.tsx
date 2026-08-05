import { useCallback, useEffect, useRef, useState } from "react";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { AudioController } from "../../lib/AudioController";

const VOLUME_STEP = 0.1;

export interface VolumeSliderProps {
  audio: AudioController;
}

export function VolumeSlider({ audio }: VolumeSliderProps) {
  // Volume UI state is owned here: it only feeds this component's icon +
  // bar width, so updates stay local instead of re-rendering the whole
  // PlayerBar tree (render-critical isolation).
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isVolumeActive, setIsVolumeActive] = useState(false);
  const volumeBarRef = useRef<HTMLDivElement>(null);

  const toggleMute = useCallback(() => {
    setIsMuted(AudioController.getInstance().toggleMute());
  }, []);

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeBarRef.current) return;
    const bounds = volumeBarRef.current.getBoundingClientRect();

    const updateVol = (clientX: number) => {
      const percent = Math.max(
        0,
        Math.min(1, (clientX - bounds.left) / bounds.width),
      );
      setVolume(percent);
      audio.setVolume(percent);
      if (percent > 0) setIsMuted(false);
      setIsVolumeActive(true);
    };

    updateVol(e.clientX);
    const onMove = (moveEvent: PointerEvent) => {
      updateVol(moveEvent.clientX);
    };
    const onUp = () => {
      setIsVolumeActive(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
      <VolumeIcon
        className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer"
        onClick={toggleMute}
      />
      <div
        ref={volumeBarRef}
        className="hidden xl:flex w-16 sm:w-24 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer relative group items-center"
        onPointerDown={handleVolumePointerDown}
      >
        <div
          className={`absolute left-0 h-full bg-gray-500 dark:bg-gray-400 group-hover:bg-[#4285F4] ${isVolumeActive ? "!bg-[#4285F4]" : ""} rounded-full transition-colors`}
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
