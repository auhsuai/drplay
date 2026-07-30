import { useState, useEffect, useRef } from "react";
import { Track } from "../../../App";
import { formatTime } from "../../../utils/formatTime";
import { renderBufferFromBytes } from '../../../utils/bufferedRange';
import { listen } from '@tauri-apps/api/event';

export function useNowPlayingProgress(currentTrack: Track | null, isOpen: boolean) {
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const tauriBufferEndRef = useRef<number | null>(null);

  // Initialize UI on track change
  useEffect(() => {
    if (currentTrack) {
      if (currentTrack.restoreTime !== undefined) {
         setDuration(currentTrack.restoreDuration || 0);
         if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(currentTrack.restoreTime);
         if (progressFillRef.current) progressFillRef.current.style.width = `${(currentTrack.restoreTime / (currentTrack.restoreDuration || 1)) * 100}%`;
      } else {
         setDuration(0);
         if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = '0:00';
         if (progressFillRef.current) progressFillRef.current.style.width = '0%';
      }
      if (bufferFillRef.current) bufferFillRef.current.innerHTML = '';
    }
  }, [currentTrack?.id, currentTrack?.streamUrl]);

  // Sync duration with audio element
  useEffect(() => {
    const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
    if (!audio) return;

    const updateDuration = () => setDuration(audio.duration || 0);

    audio.addEventListener('durationchange', updateDuration);
    audio.addEventListener('loadedmetadata', updateDuration);

    setDuration(audio.duration || 0);

    return () => {
      audio.removeEventListener('durationchange', updateDuration);
      audio.removeEventListener('loadedmetadata', updateDuration);
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

  // Realtime progress sync with audio element
  useEffect(() => {
    if (!isOpen) return;
    let lastTimeText = "";
    let lastProgressWidth = "";
    const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
    
    const updateProgressUI = () => {
      if (audio && !isDraggingRef.current && progressFillRef.current && currentTimeTextRef.current) {
        const time = audio.currentTime;

        // Prevent UI jump to 0:00 when waiting for track to restore (sync with PlayerBar)
        if (currentTrack && currentTrack.restoreTime !== undefined && time === 0 && currentTrack.restoreTime > 1) {
          return;
        }

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

    if (audio) {
      audio.addEventListener('timeupdate', updateProgressUI);
      updateProgressUI();
      
      return () => {
        audio.removeEventListener('timeupdate', updateProgressUI);
      };
    }
  }, [isOpen, duration, currentTrack]);

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
      const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
      if (audio) {
        audio.currentTime = finalTime;
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
