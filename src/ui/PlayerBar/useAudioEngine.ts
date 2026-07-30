import { useEffect, useRef, useCallback } from 'react';
import { Track } from '../../App';
import { safePlay, safePause } from '../../utils/safeAudio';
import { updateTrackDuration } from '../../utils/metadata';
import { captureError } from '../../utils/errorLog';

import { set as idbSet } from '../../db/kv';
import { PlayerAction, AudioRefs } from './types';
import type { TFunction } from 'i18next';

import { useAudioBuffering } from './useAudioBuffering';
import { useAudioErrorRecovery, classifyAudioError } from './useAudioErrorRecovery';

const AUDIO_MODULE = 'useAudioEngine';
const AUDIO_LOG = '[Player]';

const ENDED_THRESHOLD_SEC = 1.0;
const SUPPRESS_ENDED_SAFETY_MS = 15000;
const LOAD_METADATA_TIMEOUT_MS = 10_000;
const CANPLAY_TIMEOUT_MS = 30_000;

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
  pendingBufferRestoreTimeRef: React.MutableRefObject<number | null>;
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
}

export function useAudioEngine(params: UseAudioEngineParams): AudioEngineAPI {
  const { currentTrack, isPlaying, playMode, loadNonce, dispatch, t, isPlayingRef, errorInfoRef, onNextTrackRefForEnded, manualResume, rateLimitUntilRef, setDuration, setIsBuffering } = params;

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioRef2 = useRef<HTMLAudioElement>(null);
  const activeAudioIndexRef = useRef<0 | 1>(0);

  const resumeHandlerRef = useRef<{ audio: HTMLAudioElement; handler: () => void } | null>(null);
  const resumeSeekRef = useRef<{ audio: HTMLAudioElement; handler: () => void } | null>(null);
  const isProgrammaticActionRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressEndedRef = useRef(false);
  const suppressEndedSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKnownPositionRef = useRef(0);
  const errorPositionRef = useRef<number | null>(null);
  const lastSaveTimeRef = useRef(0);
  const pendingBufferRestoreTimeRef = useRef<number | null>(null);
  const restoredAudioTrackIdRef = useRef<string | null>(null);
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;

  const audioRefs: AudioRefs = { audioRef, audioRef2, activeAudioIndexRef };

  const getActiveAudio = useCallback(() => {
    return activeAudioIndexRef.current === 0 ? audioRef.current : audioRef2.current;
  }, []);

  const {
    handleWaiting,
    handlePlaying,
    handleTimeUpdateForBuffering,
    resetBuffering
  } = useAudioBuffering(isPlayingRef, errorInfoRef, setIsBuffering, getActiveAudio);

  const armSuppressEnded = () => {
    suppressEndedRef.current = true;
    if (suppressEndedSafetyRef.current) clearTimeout(suppressEndedSafetyRef.current);
    suppressEndedSafetyRef.current = setTimeout(() => {
      suppressEndedRef.current = false;
      suppressEndedSafetyRef.current = null;
    }, SUPPRESS_ENDED_SAFETY_MS);
  };

  const disarmSuppressEnded = () => {
    suppressEndedRef.current = false;
    if (suppressEndedSafetyRef.current) {
      clearTimeout(suppressEndedSafetyRef.current);
      suppressEndedSafetyRef.current = null;
    }
  };

  function cleanupResumeHandlers() {
    if (resumeHandlerRef.current) {
      resumeHandlerRef.current.audio.removeEventListener('loadedmetadata', resumeHandlerRef.current.handler);
      resumeHandlerRef.current = null;
    }
    if (resumeSeekRef.current) {
      resumeSeekRef.current.audio.removeEventListener('loadedmetadata', resumeSeekRef.current.handler);
      resumeSeekRef.current = null;
    }
  }

  function waitForAudioEvent(audio: HTMLAudioElement, event: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const handler = () => {
        if (timer) clearTimeout(timer);
        audio.removeEventListener(event, handler);
        resolve();
      };
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        audio.removeEventListener(event, handler);
        reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setTimeout(() => {
        audio.removeEventListener(event, handler);
        reject(new Error(`Timeout waiting for ${event} after ${timeoutMs}ms`));
      }, timeoutMs);
      audio.addEventListener(event, handler);
    });
  }

  async function loadNormalAudio(track: Track, position: number | null, cancellationCheck?: () => boolean): Promise<HTMLAudioElement> {
    const audio = audioRef.current;
    if (!audio || !track.streamUrl) throw new Error('No audio or stream URL');

    cleanupResumeHandlers();
    isProgrammaticActionRef.current = true;
    armSuppressEnded();

    try {
      safePause(audio);
      audio.removeAttribute('src');
      audio.src = track.streamUrl;
      audio.load();

      if (cancellationCheck?.()) throw new Error('Cancelled');

      if (position !== null) {
        if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
          await waitForAudioEvent(audio, 'loadedmetadata', LOAD_METADATA_TIMEOUT_MS);
        }
        if (cancellationCheck?.()) throw new Error('Cancelled');
        audio.currentTime = position;
      }

      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          await waitForAudioEvent(audio, 'canplay', CANPLAY_TIMEOUT_MS);
      }

      if (cancellationCheck?.()) throw new Error('Cancelled');

      if (isPlayingRef.current) {
        await safePlay(audio);
      }

      activeAudioIndexRef.current = 0;
      disarmSuppressEnded();
      return audio;
    } finally {
      isProgrammaticActionRef.current = false;
      disarmSuppressEnded();
    }
  }

  async function performRetry(track: Track): Promise<void> {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    const pos = errorPositionRef.current;
    errorPositionRef.current = null;
    dispatch({ type: 'CLEAR_ERROR' });
    try {
      await loadNormalAudio(track, pos);
      retryCountRef.current = 0;
    } catch (err) {
      retryCountRef.current += 1;
      captureError({ level: 'error', source: 'audio-engine', message: `performRetry failed (attempt ${retryCountRef.current}, ${classifyAudioError(err)})`, kind: 'retry' });
      if (retryCountRef.current < 3) {
        dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      } else {
        dispatch({ type: 'ERROR', error: { type: 'format_error', text: t('player.format_error', 'File lỗi định dạng, đang chuyển bài kế tiếp...') } });
        onNextTrackRefForEnded.current(true);
      }
    }
  }

  const { handleAudioError, clearRetryTimeout } = useAudioErrorRecovery({
    getActiveAudio, currentTrackRef, errorInfoRef, errorPositionRef,
    lastKnownPositionRef, retryCountRef, retryTimeoutRef, rateLimitUntilRef,
    performRetry, onNextTrackRefForEnded, dispatch, t
  });

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
    const isRealEnd =
      active.ended &&
      isFinite(duration) && duration > 0 &&
      isFinite(currentTime) &&
      currentTime >= duration - ENDED_THRESHOLD_SEC;

    if (!isRealEnd) {
      console.warn(
        `${AUDIO_LOG} ignored spurious ended (not at track end)`,
        { currentTime, duration, threshold: ENDED_THRESHOLD_SEC }
      );
      return;
    }

    if (playMode === 'repeat-one') {
      active.currentTime = 0;
      safePlay(active).catch(e => console.error(`${AUDIO_LOG} replay-failed`, classifyAudioError(e)));
    } else {
      onNextTrackRefForEnded.current();
    }
  };

  const handleTimeUpdate = () => {
    const audio = getActiveAudio();
    if (!audio) return;
    const time = audio.currentTime;
    if (time > 0 && isFinite(time)) lastKnownPositionRef.current = time;

    handleTimeUpdateForBuffering();

    const now = Date.now();
    if (now - lastSaveTimeRef.current > 2000 && currentTrack) {
      idbSet('drplay_last_session', {
        track: currentTrack,
        time,
        duration: audio.duration || 0
      }).catch(e => console.warn(`[${AUDIO_MODULE}] session-save-failed`, classifyAudioError(e)));
      lastSaveTimeRef.current = now;
    }
  };

  const handleLoadedMetadata = () => {
    const audio = getActiveAudio();
    if (audio) {
      const accurateDuration = audio.duration;
      setDuration(accurateDuration);
      if (currentTrack) {
        updateTrackDuration(currentTrack.id, accurateDuration);
      }
    }
  };

  const handleCanPlay = () => {
    const audio = getActiveAudio();
    retryCountRef.current = 0;
    clearRetryTimeout();
    resetBuffering();
    
    if (errorInfoRef.current) {
      dispatch({ type: 'CLEAR_ERROR' });
    }
    if (!audio) return;
    if (pendingBufferRestoreTimeRef.current !== null) {
      const t = pendingBufferRestoreTimeRef.current;
      pendingBufferRestoreTimeRef.current = null;
      if (isFinite(t)) {
        audio.currentTime = t;
      }
      return;
    }
    if (currentTrack && currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
      const t = currentTrack.restoreTime;
      if (isFinite(t)) {
        audio.currentTime = t;
      }
      restoredAudioTrackIdRef.current = currentTrack.id;
    }
  };

  useEffect(() => {
    const refs = [audioRef.current, audioRef2.current];
    for (const el of refs) {
      if (el) el.volume = 0.5;
    }
  }, []);

  useEffect(() => {
    if (!currentTrack?.streamUrl) return;
    let cancelled = false;
    const position = currentTrack.restoreTime ?? null;
    loadNormalAudio(currentTrack, position, () => cancelled).then(() => {
      if (!cancelled) dispatch({ type: 'PLAY_SUCCESS' });
    }).catch(err => {
      if (err.message === 'Cancelled') return;
      console.warn('[Player] loadNormalAudio error', err);
      if (err.name === 'NotAllowedError') {
        dispatch({ type: 'BLOCKED', time: getActiveAudio()?.currentTime ?? 0 });
      }
    });
    return () => { cancelled = true; };
  }, [loadNonce]);

  useEffect(() => {
    return () => {
      cleanupResumeHandlers();
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      resetBuffering();
    }
  }, [isPlaying, currentTrack?.id]);

  return {
    audioRefs,
    getActiveAudio,
    loadNormalAudio,
    performRetry,
    handleEnded,
    handleAudioError,
    handleTimeUpdate,
    handleLoadedMetadata,
    handleCanPlay,
    handleWaiting,
    handlePlaying,
    lastKnownPositionRef,
    errorPositionRef,
    pendingBufferRestoreTimeRef,
    restoredAudioTrackIdRef,
    retryCountRef,
    retryTimeoutRef,
  };
}
