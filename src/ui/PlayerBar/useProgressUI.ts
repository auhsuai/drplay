import React, { useEffect, useRef } from 'react';
import { formatTime } from '../../utils/formatTime';
import { Track } from '../../App';

// Maximum divergence (seconds) between the requested seek target and the actual
// playback position after a `seeked` event before we correct it back.
const SEEK_CORRECTION_THRESHOLD_SEC = 1;
// Maximum time (ms) after a drag-seek commit during which a native `seeked`
// event is still attributed to THAT specific seek. `seeked` carries no
// correlation id, so without this bound, ANY unrelated `.currentTime` write
// that happens to complete before the drag's own `seeked` arrives (a track
// change, a network-retry resume, a buffer restore -- anything else in
// useAudioEngine.ts that sets currentTime) gets its result silently
// overwritten back to wherever the user last dragged to. That reads to a
// user as a random, unexplained auto-seek with no connection to anything
// they're currently doing -- exactly this bug, found while investigating a
// user report of small spontaneous seeks during otherwise-idle playback.
const SEEK_CORRECTION_WINDOW_MS = 4000;

// Pure decision function (kept separate from the DOM/event-listener code
// below so it's directly unit-testable without a browser/jsdom).
export function shouldApplySeekCorrection(params: {
  targetTime: number;
  committedAtMs: number;
  nowMs: number;
  actualTime: number;
  thresholdSec?: number;
  windowMs?: number;
}): boolean {
  const {
    targetTime,
    committedAtMs,
    nowMs,
    actualTime,
    thresholdSec = SEEK_CORRECTION_THRESHOLD_SEC,
    windowMs = SEEK_CORRECTION_WINDOW_MS,
  } = params;
  if (nowMs - committedAtMs > windowMs) return false;
  return Math.abs(actualTime - targetTime) > thresholdSec;
}

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

export function useProgressUI(params: UseProgressUIParams): ProgressUIAPI {
  const { getActiveAudio, currentTrack, audioRef, progressBarRef, progressFillRef, currentTimeTextRef, volumeBarRef, setVolume, setIsMuted, duration } = params;
  const isDraggingRef = useRef(false);
  const lastSeekTargetRef = useRef<number | null>(null);
  const lastSeekCommitTimeRef = useRef(0);
  const isSeekCorrectionRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = getActiveAudio();
    if (!active || duration === 0 || !progressBarRef.current) return;

    isDraggingRef.current = true;
    try {
      progressBarRef.current.setPointerCapture(e.pointerId);
    } catch (err) {
      // setPointerCapture can throw (e.g. InvalidStateError) if the element is
      // detached or the pointerId is stale. It's a benign enhancement — the drag
      // still works via the window-level listeners — so log with context only.
      console.warn(`[useProgressUI] setPointerCapture failed for pointerId=${e.pointerId}`, err instanceof Error ? err.name : '');
    }
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

      const active2 = getActiveAudio();
      if (active2) {
        lastSeekTargetRef.current = finalTime;
        lastSeekCommitTimeRef.current = Date.now();
        active2.currentTime = finalTime;
      }

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
        if (shouldApplySeekCorrection({
          targetTime: lastSeekTargetRef.current,
          committedAtMs: lastSeekCommitTimeRef.current,
          nowMs: Date.now(),
          actualTime: active.currentTime,
        })) {
          isSeekCorrectionRef.current = true;
          active.currentTime = lastSeekTargetRef.current;
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
