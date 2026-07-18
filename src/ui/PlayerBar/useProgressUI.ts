import React, { useEffect, useRef } from 'react';
import { formatTime } from '../../utils/formatTime';
import { Track } from '../../App';

export interface ProgressUIAPI {
  handlePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  handleVolumePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}

interface UseProgressUIParams {
  getActiveAudio: () => HTMLAudioElement | null;
  currentTrack: Track | null;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  progressBarRef: React.RefObject<HTMLDivElement | null>;
  progressFillRef: React.RefObject<HTMLDivElement | null>;
  currentTimeTextRef: React.RefObject<HTMLSpanElement | null>;
  volumeBarRef: React.RefObject<HTMLDivElement | null>;
  setVolume: React.Dispatch<React.SetStateAction<number>>;
  setIsMuted: React.Dispatch<React.SetStateAction<boolean>>;
  duration: number;
}

const LOSSLESS_SEEK_DELAY = 400;
const SEEK_COOLDOWN = 300;
const NORMAL_SEEK_DELAY = 250;

function isLossless(name: string): boolean {
  return /\.(flac|wav|aiff|alac)$/i.test(name);
}

export function useProgressUI(params: UseProgressUIParams): ProgressUIAPI {
  const { getActiveAudio, currentTrack, audioRef, progressBarRef, progressFillRef, currentTimeTextRef, volumeBarRef, setVolume, setIsMuted, duration } = params;
  const isDraggingRef = useRef(false);
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeekTargetRef = useRef<number | null>(null);
  const isSeekCorrectionRef = useRef(false);
  const seekCorrectionCountRef = useRef(0);
  const restoredAudioTrackIdRef = useRef<string | null>(null);
  const isLosslessRef = useRef(false);
  const lastSeekTimeRef = useRef(0);
  const seekCooldownPendingRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = getActiveAudio();
    if (!active || duration === 0 || !progressBarRef.current) return;

    isDraggingRef.current = true;
    seekCorrectionCountRef.current = 0;
    try { progressBarRef.current.setPointerCapture(e.pointerId); } catch { }
    const bounds = progressBarRef.current.getBoundingClientRect();

    const updateTime = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      const newTime = percent * duration;
      if (progressFillRef.current) progressFillRef.current.style.width = `${percent * 100}%`;
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(newTime);
      return newTime;
    };

    updateTime(e.clientX);

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateTime(moveEvent.clientX);
    };

    const commit = (clientX: number) => {
      isDraggingRef.current = false;
      const finalTime = updateTime(clientX);

      if (isLosslessRef.current) {
        const now = Date.now();
        if (seekCooldownPendingRef.current || (now - lastSeekTimeRef.current) < SEEK_COOLDOWN) return;
        lastSeekTimeRef.current = now;
        seekCooldownPendingRef.current = true;
      }

      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
      }
      const delay = isLosslessRef.current ? LOSSLESS_SEEK_DELAY : NORMAL_SEEK_DELAY;
      seekTimeoutRef.current = setTimeout(() => {
        seekCooldownPendingRef.current = false;
        const active2 = getActiveAudio();
        if (active2) {
          active2.currentTime = finalTime;
        }
      }, delay);

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      commit(upEvent.clientX);
    };

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      commit(cancelEvent.clientX);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeBarRef.current) return;
    const bounds = volumeBarRef.current.getBoundingClientRect();

    const updateVolume = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      setVolume(percent);
      if (percent > 0) setIsMuted(false);
    };

    updateVolume(e.clientX);

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateVolume(moveEvent.clientX);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // Progress UI update effect (timeupdate/progress)
  useEffect(() => {
    let lastTimeText = "";
    let lastProgressWidth = "";

    const updateProgressUI = () => {
      const audio = getActiveAudio();
      if (audio && !isDraggingRef.current && progressFillRef.current && currentTimeTextRef.current) {
        if (currentTrack && currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
          return;
        }

        const time = audio.currentTime;
        const dur = audio.duration || duration;
        if (dur > 0) {
          const progressPercent = (time / dur) * 100;
          const newWidth = `${progressPercent}%`;

          if (Math.abs(parseFloat(lastProgressWidth) - progressPercent) > 0.05 || lastProgressWidth === "") {
            progressFillRef.current.style.width = newWidth;
            lastProgressWidth = newWidth;
          }

          const newTimeText = formatTime(time);
          if (lastTimeText !== newTimeText) {
            currentTimeTextRef.current.textContent = newTimeText;
            lastTimeText = newTimeText;
          }
        }
      }
    };

    const activeAudio = getActiveAudio();
    if (activeAudio) {
      activeAudio.addEventListener('timeupdate', updateProgressUI);
      activeAudio.addEventListener('progress', updateProgressUI);
      updateProgressUI();

      return () => {
        activeAudio.removeEventListener('timeupdate', updateProgressUI);
        activeAudio.removeEventListener('progress', updateProgressUI);
      };
    }
  }, [getActiveAudio, duration, currentTrack]);

  // Track lossless classification — updates whenever the current track changes.
  useEffect(() => {
    const name = currentTrack?.originalName || currentTrack?.streamUrl || '';
    isLosslessRef.current = isLossless(name);
  }, [currentTrack]);

  // Seek accuracy correction
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleSeeked = () => {
      if (isSeekCorrectionRef.current) {
        isSeekCorrectionRef.current = false;
        return;
      }
      const active = getActiveAudio();
      if (lastSeekTargetRef.current !== null && active) {
        const THRESHOLD = 2.5;
        const MAX_CORRECT = 2;
        const diff = Math.abs(active.currentTime - lastSeekTargetRef.current);
        if (diff > THRESHOLD && seekCorrectionCountRef.current < MAX_CORRECT) {
          seekCorrectionCountRef.current += 1;
          isSeekCorrectionRef.current = true;
          active.currentTime = lastSeekTargetRef.current;
        } else {
          isSeekCorrectionRef.current = false;
          seekCorrectionCountRef.current = 0;
        }
        lastSeekTargetRef.current = null;
      }
    };

    audio.addEventListener('seeked', handleSeeked);
    return () => audio.removeEventListener('seeked', handleSeeked);
  }, [getActiveAudio]);

  return {
    handlePointerDown,
    handleVolumePointerDown,
  };
}
