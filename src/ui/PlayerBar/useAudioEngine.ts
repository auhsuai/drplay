import { useEffect, useRef, useCallback } from 'react';
import { Track } from '../../App';
import { safePlay } from '../../utils/safeAudio';
import { set as idbSet } from '../../db/kv';
import { PlayerAction, AudioRefs } from './types';
import { classifyAudioError } from './utils/audioUtils';
import { ENDED_THRESHOLD_SEC } from './utils/audioConstants';
import { useBufferingState } from './hooks/useBufferingState';
import { useAudioLoader } from './hooks/useAudioLoader';
import { useAudioErrorRecovery } from './hooks/useAudioErrorRecovery';
import type { TFunction } from 'i18next';

const AUDIO_MODULE = 'useAudioEngine';
const AUDIO_LOG = '[Player]';

export interface AudioEngineAPI {
  audioRefs: AudioRefs;
  getActiveAudio: () => HTMLAudioElement | null;
  loadNormalAudio: (track: Track, position: number | null, cancellationCheck?: () => boolean) => Promise<HTMLAudioElement>;
  performRetry: (track: Track) => Promise<void>;
  handleEnded: (event?: React.SyntheticEvent<HTMLAudioElement>) => void;
  handleAudioError: () => Promise<void>;
  handleTimeUpdate: () => void;
  handleLoadedMetadata: () => void;
  handleCanPlay: () => void;
  handleWaiting: () => void;
  handlePlaying: () => void;
  lastKnownPositionRef: React.MutableRefObject<number>;
  errorPositionRef: React.MutableRefObject<number | null>;
  restoredAudioTrackIdRef: React.MutableRefObject<string | null>;
  retryCountRef: React.MutableRefObject<number>;
  retryTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

interface UseAudioEngineParams {
  currentTrack: Track | null;
  isPlaying: boolean;
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  loadNonce: number | undefined;
  dispatch: React.Dispatch<PlayerAction>;
  t: TFunction;
  isPlayingRef: React.MutableRefObject<boolean>;
  errorInfoRef: React.MutableRefObject<{ type: string; text: string } | null>;
  onNextTrackRefForEnded: React.MutableRefObject<(isAutoSkip?: boolean) => void>;
  manualResume: boolean;
  rateLimitUntilRef: React.MutableRefObject<number>;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
  setIsBuffering: React.Dispatch<React.SetStateAction<boolean>>;
  lockSystemPauseRef: React.MutableRefObject<() => void>;
}

export function useAudioEngine(params: UseAudioEngineParams): AudioEngineAPI {
  const { currentTrack, isPlaying, playMode, loadNonce, dispatch, t,
    isPlayingRef, errorInfoRef, onNextTrackRefForEnded, manualResume,
    rateLimitUntilRef, setDuration, setIsBuffering, lockSystemPauseRef } = params;

  // --- Core refs ---
  const audioRef = useRef<HTMLAudioElement>(null);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKnownPositionRef = useRef(0);
  const errorPositionRef = useRef<number | null>(null);
  const lastSaveTimeRef = useRef(0);
  const restoredAudioTrackIdRef = useRef<string | null>(null);
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;

  const audioRefs: AudioRefs = { audioRef };

  const getActiveAudio = useCallback(() => audioRef.current, []);

  // --- Buffering ---
  const { isBufferingRef, applyBuffering, clearBufferingTimers, bufferingDelayRef, stallWatchdogRef } =
    useBufferingState(setIsBuffering);

  // --- Retry timeout helper ---
  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current) { clearTimeout(retryTimeoutRef.current); retryTimeoutRef.current = null; }
  }, []);

  // --- Audio loading ---
  const { loadNormalAudio, performRetry, cleanupResumeHandlers, suppressEndedRef } = useAudioLoader({
    audioRef, isPlayingRef, errorPositionRef, retryCountRef, currentTrackRef,
    onNextTrackRefForEnded, dispatch, t, clearRetryTimeout,
    lockSystemPauseRef,
  });

  // --- Error recovery ---
  const { handleAudioError } = useAudioErrorRecovery({
    currentTrack, currentTrackRef, errorInfoRef, onNextTrackRefForEnded,
    dispatch, t, clearRetryTimeout, retryTimeoutRef, rateLimitUntilRef,
    lastKnownPositionRef, errorPositionRef, retryCountRef,
    getActiveAudio, performRetry,
  });

  // --- Event handlers ---
  const handleEnded = (event?: React.SyntheticEvent<HTMLAudioElement>) => {
    if (manualResume) return;
    if (suppressEndedRef.current) {
      console.warn(`${AUDIO_LOG} suppressed stray ended event during reload`);
      return;
    }
    const active = getActiveAudio();
    const target = event?.currentTarget ?? active;
    if (!active || target !== active) {
      console.warn(`${AUDIO_LOG} ignored ended on non-active audio element`);
      return;
    }
    const duration = active.duration;
    const currentTime = active.currentTime;
    const isRealEnd = active.ended && isFinite(duration) && duration > 0 &&
      isFinite(currentTime) && currentTime >= duration - ENDED_THRESHOLD_SEC;
    if (!isRealEnd) {
      console.warn(`${AUDIO_LOG} ignored spurious ended (not at track end)`, { currentTime, duration, threshold: ENDED_THRESHOLD_SEC });
      return;
    }
    if (playMode === 'repeat-one') {
      active.currentTime = 0;
      safePlay(active).catch(e => console.error(`${AUDIO_LOG} replay-failed`, classifyAudioError(e)));
    } else {
      onNextTrackRefForEnded.current();
    }
  };

  const handleWaiting = () => {
    if (!isPlayingRef.current || errorInfoRef.current) return;
    if (bufferingDelayRef.current || isBufferingRef.current) return;
    bufferingDelayRef.current = setTimeout(() => {
      bufferingDelayRef.current = null;
      if (isPlayingRef.current && !errorInfoRef.current) applyBuffering(true);
    }, 500);
  };

  const handlePlaying = () => { clearBufferingTimers(); applyBuffering(false); };

  const handleTimeUpdate = () => {
    const audio = getActiveAudio();
    if (!audio) return;
    const time = audio.currentTime;
    if (time > 0 && isFinite(time)) lastKnownPositionRef.current = time;
    if (bufferingDelayRef.current) { clearTimeout(bufferingDelayRef.current); bufferingDelayRef.current = null; }
    if (isBufferingRef.current) applyBuffering(false);
    if (stallWatchdogRef.current) clearTimeout(stallWatchdogRef.current);
    if (isPlayingRef.current) {
      stallWatchdogRef.current = setTimeout(() => {
        const a = getActiveAudio();
        if (a && !a.paused && !a.ended && isPlayingRef.current && !errorInfoRef.current) applyBuffering(true);
      }, 2000);
    }
    const now = Date.now();
    if (now - lastSaveTimeRef.current > 2000 && currentTrack) {
      idbSet('drplay_last_session', { track: currentTrack, time, duration: audio.duration || 0 })
        .catch(e => console.warn(`[${AUDIO_MODULE}] session-save-failed`, classifyAudioError(e)));
      lastSaveTimeRef.current = now;
    }
  };

  const handleLoadedMetadata = () => {
    const audio = getActiveAudio();
    if (audio) setDuration(audio.duration);
  };

  const handleCanPlay = () => {
    const audio = getActiveAudio();
    retryCountRef.current = 0;
    clearRetryTimeout();
    clearBufferingTimers();
    applyBuffering(false, { immediate: true });
    if (errorInfoRef.current) dispatch({ type: 'CLEAR_ERROR' });
    if (!audio) return;
    if (currentTrack && currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
      const t2 = currentTrack.restoreTime;
      if (isFinite(t2)) audio.currentTime = t2;
      restoredAudioTrackIdRef.current = currentTrack.id;
    }
  };

  // --- Effects ---
  useEffect(() => { if (audioRef.current) audioRef.current.volume = 0.5; }, []);

  useEffect(() => {
    if (!currentTrack?.streamUrl) return;
    let cancelled = false;
    const position = currentTrack.restoreTime ?? null;
    loadNormalAudio(currentTrack, position, () => cancelled).then(() => {
      if (!cancelled) dispatch({ type: 'PLAY_SUCCESS' });
    }).catch(err => {
      if (err.message === 'Cancelled') return;
      console.warn('[Player] loadNormalAudio error', err);
      if (err.name === 'NotAllowedError') dispatch({ type: 'BLOCKED', time: getActiveAudio()?.currentTime ?? 0 });
    });
    return () => { cancelled = true; };
  }, [loadNonce]);

  useEffect(() => cleanupResumeHandlers, []);

  useEffect(() => {
    if (!isPlaying) { clearBufferingTimers(); applyBuffering(false, { immediate: true }); }
  }, [isPlaying, currentTrack?.id]);

  return {
    audioRefs, getActiveAudio, loadNormalAudio, performRetry,
    handleEnded, handleAudioError, handleTimeUpdate, handleLoadedMetadata,
    handleCanPlay, handleWaiting, handlePlaying,
    lastKnownPositionRef, errorPositionRef, restoredAudioTrackIdRef,
    retryCountRef, retryTimeoutRef,
  };
}
