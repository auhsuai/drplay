import { useEffect, useRef } from 'react';

const KEY_MODULE = 'useKeyboard';

function isLossless(name: string): boolean {
  return /\.(flac|wav|aiff|alac)$/i.test(name);
}

// Classify an error for observability (no secrets logged). Mirrors the
// classify* helpers in apiClient.ts — only name/message are inspected.
function classifyKeyError(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  if (typeof err === 'string') return err;
  return 'unknown';
}

interface UseKeyboardParams {
  getActiveAudio: () => HTMLAudioElement | null;
  currentTrack: { originalName?: string; streamUrl: string } | null;
  onTogglePlayRef: React.MutableRefObject<() => void>;
  onNextTrackRef: React.MutableRefObject<() => void>;
  onPrevTrackRef: React.MutableRefObject<() => void>;
  onTogglePlayModeRef: React.MutableRefObject<() => void>;
  setVolume: React.Dispatch<React.SetStateAction<number>>;
  setIsMuted: React.Dispatch<React.SetStateAction<boolean>>;
  setIsVolumeActive: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useKeyboard(params: UseKeyboardParams): void {
  const { getActiveAudio, currentTrack, onTogglePlayRef, onNextTrackRef, onPrevTrackRef, onTogglePlayModeRef, setVolume, setIsMuted, setIsVolumeActive } = params;

  const arrowSeekBaseRef = useRef<number | null>(null);
  const isArrowSeekingRef = useRef(false);
  const arrowTargetTimeRef = useRef(0);
  const lastSeekTimestampRef = useRef(0);
  const isLosslessRef = useRef(false);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track lossless classification — updates whenever the current track changes.
  useEffect(() => {
    const name = currentTrack?.originalName || currentTrack?.streamUrl || '';
    isLosslessRef.current = isLossless(name);
  }, [currentTrack]);

  const LOSSLESS_MIN_INTERVAL = 400;
  const NORMAL_MIN_INTERVAL = 100;

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
              const minInterval = isLosslessRef.current ? LOSSLESS_MIN_INTERVAL : NORMAL_MIN_INTERVAL;
              if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > minInterval) {
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
              const minInterval = isLosslessRef.current ? LOSSLESS_MIN_INTERVAL : NORMAL_MIN_INTERVAL;
              if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > minInterval) {
                arrowSeekBaseRef.current = active.currentTime;
              }
              lastSeekTimestampRef.current = now;
              const dur = active.duration || 0;
              const newTime = Math.min(dur, arrowSeekBaseRef.current + 5);
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

  // Keyup: kết thúc arrow seeking → seek audio element một lần duy nhất
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && isArrowSeekingRef.current) {
        const active = getActiveAudio();
        if (active) {
          isArrowSeekingRef.current = false;
          const target = arrowTargetTimeRef.current;
          if (target > 0) {
            active.currentTime = target;
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
