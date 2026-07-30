import React, { useEffect, useRef, useState, useCallback } from 'react';
import { formatTime } from '../../utils/formatTime';
import { PlaybackState, AudioEngineAPI } from './useAudioEngine';

export interface ProgressUIAPI {
  handlePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  handleVolumePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  hoverTime: number | null;
  hoverPercent: number;
  handlePointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  handlePointerLeave: () => void;
  blockTickerUpdates: (durationMs: number) => void;
}

interface UseProgressUIParams {
  playbackState: PlaybackState;
  engine: AudioEngineAPI;
  progressBarRef: React.RefObject<HTMLDivElement | null>;
  progressFillRef: React.RefObject<HTMLDivElement | null>;
  currentTimeTextRef: React.RefObject<HTMLSpanElement | null>;
  volumeBarRef: React.RefObject<HTMLDivElement | null>;
  setVolume: React.Dispatch<React.SetStateAction<number>>;
  setIsMuted: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useProgressUI(params: UseProgressUIParams): ProgressUIAPI {
  const { playbackState, engine, progressBarRef, progressFillRef, currentTimeTextRef, volumeBarRef, setVolume, setIsMuted } = params;
  const isDraggingRef = useRef(false);
  const seekPendingRef = useRef(false);
  const seekPendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPercent, setHoverPercent] = useState(0);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) return;
    if (!progressBarRef.current) return;
    const bounds = progressBarRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width));
    const dur = playbackState.duration;
    if (dur > 0) {
      setHoverTime(pct * dur);
      setHoverPercent(pct * 100);
    }
  }, [playbackState.duration, progressBarRef]);

  const handlePointerLeave = useCallback(() => {
    if (!isDraggingRef.current) {
      setHoverTime(null);
    }
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return;

    isDraggingRef.current = true;
    try {
      progressBarRef.current.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw if element is detached — benign
    }
    const bounds = progressBarRef.current.getBoundingClientRect();
    const dur = playbackState.duration;

    const updateTime = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      const newTime = percent * (dur > 0 ? dur : 0);
      if (dur > 0 && progressFillRef.current) progressFillRef.current.style.width = `${percent * 100}%`;
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(newTime);
      return newTime;
    };

    updateTime(e.clientX);

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateTime(moveEvent.clientX);
    };

    const commit = (clientX: number) => {
      isDraggingRef.current = false;
      seekPendingRef.current = true;
      if (seekPendingTimeoutRef.current) clearTimeout(seekPendingTimeoutRef.current);
      seekPendingTimeoutRef.current = setTimeout(() => {
        seekPendingRef.current = false;
        seekPendingTimeoutRef.current = null;
      }, 500);
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      if (dur > 0) {
        const finalTime = percent * dur;
        engine.seek(finalTime).catch(e => console.error('[seek]', e));
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

  // Progress UI update from playbackState
  useEffect(() => {
    let lastTimeText = "";
    let lastProgressWidth = "";

    const updateProgressUI = () => {
      if (isDraggingRef.current || seekPendingRef.current) return;
      const time = playbackState.position;
      const dur = playbackState.duration;

      // Always update time text, even when duration is unknown (dur === 0)
      if (currentTimeTextRef.current) {
        const newTimeText = formatTime(time);
        if (lastTimeText !== newTimeText) {
          currentTimeTextRef.current.textContent = newTimeText;
          lastTimeText = newTimeText;
        }
      }

      // Only update progress bar when duration > 0
      if (dur > 0 && progressFillRef.current) {
        const progressPercent = Math.min(100, Math.max(0, (time / dur) * 100));
        const newWidth = `${progressPercent}%`;

        if (Math.abs(parseFloat(lastProgressWidth) - progressPercent) > 0.05 || lastProgressWidth === "") {
          progressFillRef.current.style.width = newWidth;
          lastProgressWidth = newWidth;
        }
      }
    };

    updateProgressUI();
  }, [playbackState.position, playbackState.duration]);

  const blockTickerUpdates = useCallback((durationMs: number) => {
    seekPendingRef.current = true;
    if (seekPendingTimeoutRef.current) clearTimeout(seekPendingTimeoutRef.current);
    seekPendingTimeoutRef.current = setTimeout(() => {
      seekPendingRef.current = false;
      seekPendingTimeoutRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (seekPendingTimeoutRef.current) clearTimeout(seekPendingTimeoutRef.current);
    };
  }, []);

  return {
    handlePointerDown,
    handleVolumePointerDown,
    hoverTime,
    hoverPercent,
    handlePointerMove,
    handlePointerLeave,
    blockTickerUpdates,
  };
}
