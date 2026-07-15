import { useEffect, useRef } from 'react';
import { formatTime } from '../../utils/formatTime';

const KEY_MODULE = 'useKeyboard';

// Classify an error for observability (no secrets logged). Mirrors the
// classify* helpers in apiClient.ts — only name/message are inspected.
function classifyKeyError(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  if (typeof err === 'string') return err;
  return 'unknown';
}

interface UseKeyboardParams {
  getActiveAudio: () => HTMLAudioElement | null;
  onTogglePlayRef: React.MutableRefObject<() => void>;
  onNextTrackRef: React.MutableRefObject<() => void>;
  onPrevTrackRef: React.MutableRefObject<() => void>;
  onTogglePlayModeRef: React.MutableRefObject<() => void>;
  setVolume: React.Dispatch<React.SetStateAction<number>>;
  setIsMuted: React.Dispatch<React.SetStateAction<boolean>>;
  setIsVolumeActive: React.Dispatch<React.SetStateAction<boolean>>;
  progressFillRef: React.RefObject<HTMLDivElement | null>;
  currentTimeTextRef: React.RefObject<HTMLSpanElement | null>;
}

export function useKeyboard(params: UseKeyboardParams): void {
  const { getActiveAudio, onTogglePlayRef, onNextTrackRef, onPrevTrackRef, onTogglePlayModeRef, setVolume, setIsMuted, setIsVolumeActive, progressFillRef, currentTimeTextRef } = params;

  const arrowSeekBaseRef = useRef<number | null>(null);
  const isArrowSeekingRef = useRef(false);
  const arrowTargetTimeRef = useRef(0);
  const lastSeekTimestampRef = useRef(0);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerVolumeActive = () => {
    setIsVolumeActive(true);
    if (volumeTimeoutRef.current) clearTimeout(volumeTimeoutRef.current);
    volumeTimeoutRef.current = setTimeout(() => setIsVolumeActive(false), 300);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          {
            const active = getActiveAudio();
            if (active) {
              const now = Date.now();
              if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > 500) {
                arrowSeekBaseRef.current = active.currentTime;
              }
              lastSeekTimestampRef.current = now;
              const newTime = Math.max(0, arrowSeekBaseRef.current - 5);
              arrowSeekBaseRef.current = newTime;
              active.currentTime = newTime;
            }
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          {
            const active = getActiveAudio();
            if (active) {
              const now = Date.now();
              if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > 500) {
                arrowSeekBaseRef.current = active.currentTime;
              }
              lastSeekTimestampRef.current = now;
              const dur = active.duration || 0;
              const newTime = Math.min(dur, arrowSeekBaseRef.current + 5);
              arrowSeekBaseRef.current = newTime;

              const activeForBuf = getActiveAudio();
              let isInBuffer = true;
              if (activeForBuf && activeForBuf.buffered.length > 0 && dur > 0) {
                isInBuffer = false;
                const b = activeForBuf.buffered;
                for (let i = 0; i < b.length; i++) {
                  if (newTime >= b.start(i) && newTime <= b.end(i)) {
                    isInBuffer = true;
                    break;
                  }
                }
              }

              if (isInBuffer) {
                active.currentTime = newTime;
                isArrowSeekingRef.current = false;
              } else {
                isArrowSeekingRef.current = true;
                arrowTargetTimeRef.current = newTime;
                if (currentTimeTextRef.current) {
                  currentTimeTextRef.current.textContent = formatTime(newTime);
                }
                if (progressFillRef.current && dur > 0) {
                  progressFillRef.current.style.width = `${(newTime / dur) * 100}%`;
                }
              }
            }
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          triggerVolumeActive();
          setVolume(prev => Math.min(1, prev + 0.1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          triggerVolumeActive();
          setVolume(prev => Math.max(0, prev - 0.1));
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          setIsMuted(prev => !prev);
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          onNextTrackRef.current();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          onPrevTrackRef.current();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          onTogglePlayModeRef.current();
          break;
        case 'F11':
          e.preventDefault();
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(e => console.error(`[${KEY_MODULE}] fullscreen-enter-failed`, classifyKeyError(e)));
          } else {
            if (document.exitFullscreen) {
              document.exitFullscreen().catch(e => console.error(`[${KEY_MODULE}] fullscreen-exit-failed`, classifyKeyError(e)));
            }
          }
          break;
        case ' ':
          e.preventDefault();
          onTogglePlayRef.current();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Keyup: kết thúc arrow seeking → seek audio element một lần duy nhất
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && isArrowSeekingRef.current) {
        const active = getActiveAudio();
        if (active) {
          isArrowSeekingRef.current = false;
          const target = arrowTargetTimeRef.current;
          if (target > 0) {
            const b = active.buffered;
            let inBuffer = false;
            for (let i = 0; i < b.length; i++) {
              if (target >= b.start(i) && target <= b.end(i)) { inBuffer = true; break; }
            }
            if (inBuffer) {
              active.currentTime = target;
            } else {
              const onProgress = () => {
                const b2 = active.buffered;
                for (let i = 0; i < b2.length; i++) {
                  if (target >= b2.start(i) && target <= b2.end(i)) {
                    active.currentTime = target;
                    active.removeEventListener('progress', onProgress);
                    break;
                  }
                }
              };
              active.addEventListener('progress', onProgress);
              setTimeout(() => { active.removeEventListener('progress', onProgress); active.currentTime = target; }, 10000);
            }
          }
        }
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        arrowSeekBaseRef.current = null;
      }
    };

    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, []);

  return undefined;
}
