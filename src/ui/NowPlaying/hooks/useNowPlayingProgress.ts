import { useState, useEffect, useRef } from "react";
import { Track } from "../../../App";
import { formatTime } from "../../../utils/formatTime";
import { updateBufferBar, clearBufferBar } from '../../../utils/bufferedRange';
import { captureError } from "../../../utils/errorLog";
import { AudioController } from "../../../lib/AudioController";

const NOW_PLAYING_PROGRESS_MODULE = 'useNowPlayingProgress';
const PROGRESS_DELTA_THRESHOLD_PCT = 0.05;
const RESTORE_GUARD_SECONDS = 1;

export function useNowPlayingProgress(currentTrack: Track | null, isOpen: boolean) {
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  // Mirror of `duration` used by the event-driven progress handler so it never
  // needs to be re-created when the duration state changes.
  const durationRef = useRef(0);
  // Handlers registered on `window` by handlePointerDown are mirrored into
  // refs so the unmount cleanup below can remove them even when the component
  // unmounts mid-drag — otherwise the listeners would leak and keep firing
  // setState on the unmounted component. No-op initials make removal of a
  // never-registered handler safe (removeEventListener is a no-op then).
  const pointerMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerUpRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerCancelRef = useRef<(e: PointerEvent) => void>(() => {});

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
      if (bufferFillRef.current) clearBufferBar(bufferFillRef.current);
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
  }, [currentTrack?.id]);

  // Buffer sync with the native media buffering state. The Service Worker
  // passthrough stream populates HTMLMediaElement.buffered normally, and the
  // browser fires the native `progress` event whenever buffered data grows
  // (paused or playing). AudioController re-emits it (throttled), so we render
  // the buffer bar from `audio.buffered` — the industry-standard source.
  useEffect(() => {
    if (!currentTrack) return;
    const audio = AudioController.getInstance();

    const unsubProgress = audio.on('progress', () => {
      updateBufferBar(bufferFillRef.current, audio.getBuffered());
    });

    return () => {
      unsubProgress();
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
      if (currentTrack && currentTrack.restoreTime !== undefined && time === 0 && currentTrack.restoreTime > RESTORE_GUARD_SECONDS) {
        return;
      }

      const dur = duration || durationRef.current;
      if (dur > 0) {
        const progressPercent = (time / dur) * 100;
        const newWidth = `${progressPercent}%`;
        
        if (Math.abs(parseFloat(lastProgressWidth) - progressPercent) > PROGRESS_DELTA_THRESHOLD_PCT || lastProgressWidth === "") {
          progressFillRef.current.style.width = newWidth;
          lastProgressWidth = newWidth;
        }
        
        const newTimeText = formatTime(time);
        if (lastTimeText !== newTimeText) {
          currentTimeTextRef.current.textContent = newTimeText;
          lastTimeText = newTimeText;
        }
      }

      // Buffer bar fallback: the last native `progress` event can fire with
      // buffered still empty before a small/fast file finishes loading (no
      // further progress event ever fires). timeupdate (~4/s) re-reads the
      // real buffered state so the bar cannot stay empty once it's full.
      // DOM-only — no React re-render.
      updateBufferBar(bufferFillRef.current, audio.getBuffered());
    };

    const unsubTime = audio.on('timeupdate', updateProgressUI);

    return () => {
      unsubTime();
    };
  }, [isOpen, currentTrack]);

  // Unmount safety net: if the component unmounts mid-drag (view closed /
  // track switched while dragging), the window listeners added by
  // handlePointerDown would otherwise never be removed.
  useEffect(() => () => {
    window.removeEventListener('pointermove', pointerMoveRef.current);
    window.removeEventListener('pointerup', pointerUpRef.current);
    window.removeEventListener('pointercancel', pointerCancelRef.current);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return;
    setIsDragging(true);
    isDraggingRef.current = true;
    try {
      progressBarRef.current.setPointerCapture(e.pointerId);
    } catch (err) {
      captureError({ level: 'warn', source: NOW_PLAYING_PROGRESS_MODULE, message: `set-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    const bounds = progressBarRef.current.getBoundingClientRect();
    
    const updateTimeUI = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      const newTime = percent * (durationRef.current || duration);
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
      // Redraw immediately (not clear): updateBufferBar drops stale pre-seek
      // ranges, so the bar shows the real buffer at the new position without
      // the empty-bar blink a synchronous clear would cause.
      updateBufferBar(bufferFillRef.current, AudioController.getInstance().getBuffered());
      window.removeEventListener('pointermove', pointerMoveRef.current);
      window.removeEventListener('pointerup', pointerUpRef.current);
      window.removeEventListener('pointercancel', pointerCancelRef.current);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      commit(upEvent.clientX);
    };

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      commit(cancelEvent.clientX);
    };

    pointerMoveRef.current = onPointerMove;
    pointerUpRef.current = onPointerUp;
    pointerCancelRef.current = onPointerCancel;
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
