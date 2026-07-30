import { useEffect, useRef } from 'react';
import { AudioEngineAPI } from './useAudioEngine';

const KEY_MODULE = 'useKeyboard';

const ARROW_SEEK_STEP_SEC = 5;
const ARROW_SEEK_BASE_EXPIRE_MS = 500;
const VOLUME_INDICATOR_MS = 300;

function classifyKeyError(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  if (typeof err === 'string') return err;
  return 'unknown';
}

interface UseKeyboardParams {
  engine: AudioEngineAPI;
  onTogglePlayRef: React.MutableRefObject<() => void>;
  onNextTrackRef: React.MutableRefObject<() => void>;
  onPrevTrackRef: React.MutableRefObject<() => void>;
  onTogglePlayModeRef: React.MutableRefObject<() => void>;
  setVolume: React.Dispatch<React.SetStateAction<number>>;
  setIsMuted: React.Dispatch<React.SetStateAction<boolean>>;
  setIsVolumeActive: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useKeyboard(params: UseKeyboardParams): void {
  const { engine, onTogglePlayRef, onNextTrackRef, onPrevTrackRef, onTogglePlayModeRef, setVolume, setIsMuted, setIsVolumeActive } = params;

  const lastActionTimeRef = useRef(0);
  const KEYBOARD_DEBOUNCE_MS = 100;
  const arrowSeekBaseRef = useRef<number | null>(null);
  const lastSeekTimestampRef = useRef(0);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackStateRef = useRef(engine.playbackState);
  playbackStateRef.current = engine.playbackState;

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

      const now = Date.now()
      if (now - lastActionTimeRef.current < KEYBOARD_DEBOUNCE_MS) return
      lastActionTimeRef.current = now

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          {
            const now = Date.now();
            const ps = playbackStateRef.current;
            const currentPos = ps.position;
            if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > ARROW_SEEK_BASE_EXPIRE_MS) {
              arrowSeekBaseRef.current = currentPos;
            }
            lastSeekTimestampRef.current = now;
            const newTime = Math.max(0, arrowSeekBaseRef.current - ARROW_SEEK_STEP_SEC);
            arrowSeekBaseRef.current = newTime;
            engine.seek(newTime, 400);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          {
            const now = Date.now();
            const ps = playbackStateRef.current;
            const currentPos = ps.position;
            const dur = ps.duration;
            if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > ARROW_SEEK_BASE_EXPIRE_MS) {
              arrowSeekBaseRef.current = currentPos;
            }
            lastSeekTimestampRef.current = now;
            const newTime = Math.min(dur && dur > 0 ? dur : Infinity, arrowSeekBaseRef.current + ARROW_SEEK_STEP_SEC);
            arrowSeekBaseRef.current = newTime;
            engine.seek(newTime, 400);
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
