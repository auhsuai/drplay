import { useState, useEffect, useRef } from "react";
import { Track } from "../../../App";
import { formatTime } from "../../../utils/formatTime";
import { renderBufferFromBytes } from '../../../utils/bufferedRange';
import { listen } from '@tauri-apps/api/event';
import { AudioController } from "../../../lib/AudioController";

export function useNowPlayingProgress(currentTrack: Track | null, isOpen: boolean) {
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const tauriBufferEndRef = useRef<number | null>(null);
  // Mirror of `duration` used by the event-driven progress handler so it never
  // needs to be re-created when the duration state changes.
  const durationRef = useRef(0);

  // Initialize UI on track change
  useEffect(() => {
    if (currentTrack) {
      if (currentTrack.restoreTime !== undefined) {
         const restoredDuration = currentTrack.restoreDuration || 0;
         durationRef.current = restoredDuration;
         setDuration(restoredDuration);
         if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(currentTrack.restoreTime);
         if (progressFillRef.current) progressFillRef.current.style.width = `${(currentTrack.restoreTime / (currentTrack.restoreDuration || 1)) * 100}%`;
      } else {
         durationRef.current = 0;
         setDuration(0);
         if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = '0:00';
         if (progressFillRef.current) progressFillRef.current.style.width = '0%';
      }
      if (bufferFillRef.current) bufferFillRef.current.innerHTML = '';
    }
  }, [currentTrack?.id, currentTrack?.streamUrl]);

  // Sync duration with AudioController. The audio element is NOT in the DOM —
  // it lives inside the AudioController singleton, so its event system (and
  // getters) is the only source of truth for the real duration.
  useEffect(() => {
    const audio = AudioController.getInstance();

    const unsubDuration = audio.on('durationchange', ({ duration }) => {
      const d = duration || 0;
      durationRef.current = d;
      setDuration(d);
    });

    // Seed with whatever metadata the active element already has.
    const initialDuration = audio.getDuration();
    if (initialDuration > 0 && initialDuration !== durationRef.current) {
      durationRef.current = initialDuration;
      setDuration(initialDuration);
    }

    return () => {
      unsubDuration();
    };
  }, [currentTrack]);

  // Buffer sync with backend Tauri event
  useEffect(() => {
    tauriBufferEndRef.current = null;
    let bufferFn: (() => void) | null = null;
    let bufferCancelled = false;
    listen<{
      track_id: string;
      buffer_start_byte: number;
      buffer_end_byte: number;
      total_size_byte: number;
    }>('buffer-status', (event) => {
      if (currentTrack && event.payload.track_id === currentTrack.id) {
        const { buffer_start_byte, buffer_end_byte, total_size_byte } = event.payload;
        if (total_size_byte > 0) {
          tauriBufferEndRef.current = (buffer_end_byte / total_size_byte) * 100;
          renderBufferFromBytes(bufferFillRef.current, buffer_start_byte, buffer_end_byte, total_size_byte);
        }
      }
    }).then(fn => {
      if (bufferCancelled) { fn(); return; }
      bufferFn = fn;
    });

    return () => {
      bufferCancelled = true;
      bufferFn?.();
    };
  }, [currentTrack?.id]);

  // Realtime progress sync with AudioController events
  useEffect(() => {
    if (!isOpen) return;
    let lastTimeText = "";
    let lastProgressWidth = "";
    const audio = AudioController.getInstance();

    const updateProgressUI = ({ currentTime, duration }: { currentTime: number; duration: number }) => {
      if (isDraggingRef.current || !progressFillRef.current || !currentTimeTextRef.current) return;
      const time = currentTime;

      // Prevent UI jump to 0:00 when waiting for track to restore (sync with PlayerBar)
      if (currentTrack && currentTrack.restoreTime !== undefined && time === 0 && currentTrack.restoreTime > 1) {
        return;
      }

      const dur = duration || durationRef.current;
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
    };

    const unsubTime = audio.on('timeupdate', updateProgressUI);

    return () => {
      unsubTime();
    };
  }, [isOpen, currentTrack]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return;
    setIsDragging(true);
    isDraggingRef.current = true;
    try { progressBarRef.current.setPointerCapture(e.pointerId); } catch (err) { console.warn('[NowPlaying] setPointerCapture failed', err); }
    const bounds = progressBarRef.current.getBoundingClientRect();
    
    const updateTimeUI = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      const newTime = percent * duration;
      if (progressFillRef.current) progressFillRef.current.style.width = `${percent * 100}%`;
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(newTime);
      return newTime;
    };
    
    updateTimeUI(e.clientX);
    
    const onPointerMove = (moveEvent: PointerEvent) => {
      updateTimeUI(moveEvent.clientX);
    };
    
    const commit = (clientX: number) => {
      setIsDragging(false);
      isDraggingRef.current = false;
      const finalTime = updateTimeUI(clientX);
      AudioController.getInstance().seek(finalTime);
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

  return {
    duration,
    isDragging,
    progressBarRef,
    progressFillRef,
    bufferFillRef,
    currentTimeTextRef,
    handlePointerDown
  };
}
