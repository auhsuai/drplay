import React, { useEffect, useRef } from 'react';
import { formatTime } from '../../utils/formatTime';
import { PlaybackState, AudioEngineAPI } from './useAudioEngine';

export interface ProgressUIAPI {
  handlePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  handleVolumePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
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
      const newTime = percent * (dur > 0 ? dur : playbackState.position + 1);
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
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      const finalTime = percent * (dur > 0 ? dur : playbackState.position + 1);
      engine.seek(finalTime).catch(e => console.error('[seek]', e));

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
      if (isDraggingRef.current) return;
      const time = playbackState.position;
      const dur = playbackState.duration;
      if (dur > 0 && progressFillRef.current && currentTimeTextRef.current) {
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
    };

    updateProgressUI();
  }, [playbackState.position, playbackState.duration]);

  return {
    handlePointerDown,
    handleVolumePointerDown,
  };
}
