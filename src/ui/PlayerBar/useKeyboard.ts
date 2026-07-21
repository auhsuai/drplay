import { useEffect, useRef } from 'react';

const KEY_MODULE = 'useKeyboard';

// Nudge (seconds) applied per Left/Right arrow key press.
const ARROW_SEEK_STEP_SEC = 5;
// Window (ms) after the last arrow seek before the base position is reset, so
// repeated presses accumulate from the same anchor instead of re-anchoring.
const ARROW_SEEK_BASE_EXPIRE_MS = 500;
// How long (ms) the volume HUD stays visible after the last volume keypress.
const VOLUME_INDICATOR_MS = 300;

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
}

export function useKeyboard(params: UseKeyboardParams): void {
  const { getActiveAudio, onTogglePlayRef, onNextTrackRef, onPrevTrackRef, onTogglePlayModeRef, setVolume, setIsMuted, setIsVolumeActive } = params;

  const arrowSeekBaseRef = useRef<number | null>(null);
  const lastSeekTimestampRef = useRef(0);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerVolumeActive = () => {
    setIsVolumeActive(true);
    if (volumeTimeoutRef.current) clearTimeout(volumeTimeoutRef.current);
    volumeTimeoutRef.current = setTimeout(() => setIsVolumeActive(false), VOLUME_INDICATOR_MS);
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
              if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > ARROW_SEEK_BASE_EXPIRE_MS) {
                arrowSeekBaseRef.current = active.currentTime;
              }
              lastSeekTimestampRef.current = now;
              const newTime = Math.max(0, arrowSeekBaseRef.current - ARROW_SEEK_STEP_SEC);
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
              if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > ARROW_SEEK_BASE_EXPIRE_MS) {
                arrowSeekBaseRef.current = active.currentTime;
              }
              lastSeekTimestampRef.current = now;
              const dur = active.duration || 0;
              const newTime = Math.min(dur, arrowSeekBaseRef.current + ARROW_SEEK_STEP_SEC);
              arrowSeekBaseRef.current = newTime;

            active.currentTime = newTime;
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

  // Keyup: reset the arrow-seek accumulation anchor so the next press starts
  // fresh from the current position instead of continuing an old sequence.
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        arrowSeekBaseRef.current = null;
      }
    };

    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, []);

  return undefined;
}
