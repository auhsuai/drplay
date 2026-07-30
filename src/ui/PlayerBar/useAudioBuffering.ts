import { useRef, useEffect } from 'react';

export function useAudioBuffering(
  isPlayingRef: React.MutableRefObject<boolean>,
  errorInfoRef: React.MutableRefObject<{ type: string; text: string } | null>,
  setIsBuffering: React.Dispatch<React.SetStateAction<boolean>>,
  getActiveAudio: () => HTMLAudioElement | null
) {
  const isBufferingRef = useRef(false);
  const bufferingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyBuffering = (v: boolean) => {
    if (isBufferingRef.current === v) return;
    isBufferingRef.current = v;
    setIsBuffering(v);
  };

  const clearBufferingTimers = () => {
    if (bufferingDelayRef.current) { clearTimeout(bufferingDelayRef.current); bufferingDelayRef.current = null; }
    if (stallWatchdogRef.current) { clearTimeout(stallWatchdogRef.current); stallWatchdogRef.current = null; }
  };

  const handleWaiting = () => {
    if (!isPlayingRef.current || errorInfoRef.current) return;
    if (bufferingDelayRef.current || isBufferingRef.current) return;
    bufferingDelayRef.current = setTimeout(() => {
      bufferingDelayRef.current = null;
      if (isPlayingRef.current && !errorInfoRef.current) applyBuffering(true);
    }, 500);
  };

  const handlePlaying = () => {
    clearBufferingTimers();
    applyBuffering(false);
  };

  const handleTimeUpdateForBuffering = () => {
    if (bufferingDelayRef.current) { clearTimeout(bufferingDelayRef.current); bufferingDelayRef.current = null; }
    if (isBufferingRef.current) applyBuffering(false);
    
    if (stallWatchdogRef.current) clearTimeout(stallWatchdogRef.current);
    if (isPlayingRef.current) {
      stallWatchdogRef.current = setTimeout(() => {
        const a = getActiveAudio();
        if (a && !a.paused && !a.ended && isPlayingRef.current && !errorInfoRef.current) {
          applyBuffering(true);
        }
      }, 2000);
    }
  };

  const resetBuffering = () => {
    clearBufferingTimers();
    applyBuffering(false);
  };

  useEffect(() => clearBufferingTimers, []);

  return {
    handleWaiting,
    handlePlaying,
    handleTimeUpdateForBuffering,
    resetBuffering
  };
}
