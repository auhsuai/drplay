import { useEffect, useRef, useCallback } from 'react';
import { Track } from '../../App';
import { safePlay, safePause } from '../../utils/safeAudio';
import { captureError } from '../../utils/errorLog';
import { PlayerAction, MAX_CONSECUTIVE_AUTO_SKIP, CallbackRefs } from './types';
import type { TFunction } from 'i18next';
import { useMediaSession } from './hooks/useMediaSession';
import { usePlaybackEventListeners } from './hooks/usePlaybackEventListeners';

const TRANSITION_RESET_MS = 200;

interface UsePlaybackControlParams {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  onNextTrackRef: React.MutableRefObject<() => void>;
  onPrevTrackRef: React.MutableRefObject<() => void>;
  onTogglePlayMode: () => void;
  onExpandNowPlaying: () => void;
  dispatch: React.Dispatch<PlayerAction>;
  t: TFunction;
  playerState: { error: { type: string; text: string } | null; manualResume: boolean; pendingResumeTime: number | null };
  getActiveAudio: () => HTMLAudioElement | null;
  loadNormalAudio: (track: Track, position: number | null, cancellationCheck?: () => boolean) => Promise<HTMLAudioElement>;
  performRetry: (track: Track) => Promise<void>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  audioRef2: React.RefObject<HTMLAudioElement | null>;
  activeAudioIndexRef: React.MutableRefObject<0 | 1>;
  lastKnownPositionRef: React.MutableRefObject<number>;
  errorPositionRef: React.MutableRefObject<number | null>;
  rateLimitUntilRef: React.MutableRefObject<number>;
}

export interface PlaybackControlAPI {
  handleNextClick: (isAutoSkip?: boolean) => void;
  handlePrevClick: () => void;
  handleManualResume: () => Promise<void>;
  handleRetry: () => Promise<void>;
  callbackRefs: CallbackRefs;
  isPlayingRef: React.MutableRefObject<boolean>;
  errorInfoRef: React.MutableRefObject<{ type: string; text: string } | null>;
}

export function usePlaybackControl(params: UsePlaybackControlParams): PlaybackControlAPI {
  const { currentTrack, isPlaying, onTogglePlay, onNextTrack, onPrevTrack, onNextTrackRef, onPrevTrackRef, onTogglePlayMode, onExpandNowPlaying, dispatch, t, playerState, getActiveAudio, loadNormalAudio, performRetry, audioRef, audioRef2, activeAudioIndexRef, lastKnownPositionRef, errorPositionRef, rateLimitUntilRef } = params;

  const { error: errorInfo, pendingResumeTime } = playerState;
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;

  const onTogglePlayRef = useRef(onTogglePlay);
  const onTogglePlayModeRef = useRef(onTogglePlayMode);
  const onToggleNowPlayingRef = useRef(onExpandNowPlaying);
  const isPlayingRef = useRef(isPlaying);
  const errorInfoRef = useRef(errorInfo);
  const handleManualResumeRef = useRef<(() => void) | null>(null);

  const isTransitioningRef = useRef(false);
  const isAutoTransitioningRef = useRef(false);
  const consecutiveAutoSkipRef = useRef(0);
  const formatRetryCountRef = useRef(0);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    errorInfoRef.current = errorInfo;
  }, [errorInfo]);

  const handleNextClick = (isAutoSkip = false) => {
    if (isAutoSkip) {
      if (isAutoTransitioningRef.current) return;
      isAutoTransitioningRef.current = true;
      consecutiveAutoSkipRef.current += 1;
      if (consecutiveAutoSkipRef.current >= MAX_CONSECUTIVE_AUTO_SKIP) {
        consecutiveAutoSkipRef.current = 0;
        isAutoTransitioningRef.current = false;
        dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.playlist_error', 'Nhiều bài liên tiếp bị lỗi, đã dừng phát') } });
        onTogglePlayRef.current();
        return;
      }
    } else {
      consecutiveAutoSkipRef.current = 0;
      if (isTransitioningRef.current) return;
      isTransitioningRef.current = true;
    }
    try {
      onNextTrack();
    } catch (err) {
      captureError({ level: 'error', source: 'playback-control', message: `onNextTrack threw`, kind: 'navigation' });
    } finally {
      setTimeout(() => {
        if (isAutoSkip) isAutoTransitioningRef.current = false;
        else isTransitioningRef.current = false;
      }, TRANSITION_RESET_MS);
    }
  };

  const handlePrevClick = () => {
    if (isTransitioningRef.current) return;
    isTransitioningRef.current = true;
    try {
      onPrevTrack();
    } catch (err) {
      captureError({ level: 'error', source: 'playback-control', message: `onPrevTrack threw`, kind: 'navigation' });
    } finally {
      setTimeout(() => { isTransitioningRef.current = false; }, TRANSITION_RESET_MS);
    }
  };

  const handleRetry = useCallback(async () => {
    if (!currentTrack?.streamUrl) return;
    if (errorInfoRef.current?.type === 'format_error') {
      formatRetryCountRef.current += 1;
      if (formatRetryCountRef.current >= 2) {
        formatRetryCountRef.current = 0;
        dispatch({ type: 'ERROR', error: { type: 'format_error', text: t('player.seek_too_fast', 'Shouldn\'t seek too fast with lossless file type. Skipping...') } });
        onNextTrackRef.current();
        return;
      }
      const pos = errorPositionRef.current;
      errorPositionRef.current = null;
      dispatch({ type: 'CLEAR_ERROR' });
      try {
        await loadNormalAudio(currentTrack, pos);
        formatRetryCountRef.current = 0;
        return;
      } catch {
        // Fallback handled by player
      }
    }
    await performRetry(currentTrack);
  }, [currentTrack, performRetry, loadNormalAudio, dispatch, t, onNextTrackRef]);

  async function handleManualResume() {
    if (!currentTrack?.streamUrl || pendingResumeTime === null) return;
    const resumeTime = pendingResumeTime;
    if (!isFinite(resumeTime) || resumeTime < 0) {
      dispatch({ type: 'BLOCKED', time: null });
      return;
    }
    try {
      await loadNormalAudio(currentTrack, resumeTime);
      dispatch({ type: 'RESUMED' });
    } catch (err: unknown) {
      const errName = (typeof err === 'object' && err !== null && 'name' in err) ? (err as { name: string }).name : undefined;
      captureError({ level: 'error', source: 'playback-control', message: `Manual resume failed`, kind: 'resume' });
      if (errName === 'NotAllowedError') {
        dispatch({ type: 'BLOCKED', time: resumeTime });
      } else {
        dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      }
    }
  }

  useEffect(() => {
    handleManualResumeRef.current = handleManualResume;
  }, [handleManualResume]);

  // Hook for media keys / taskbar
  useMediaSession(currentTrack, onTogglePlayRef, onPrevTrackRef, onNextTrackRef);

  // Hook for all other event listeners (OS, Tauri, Network, Bluetooth)
  usePlaybackEventListeners(
    currentTrackRef, isPlayingRef, errorInfoRef, errorPositionRef, lastKnownPositionRef, isTransitioningRef,
    onTogglePlayRef, dispatch, t, getActiveAudio, loadNormalAudio, performRetry, audioRef, audioRef2, activeAudioIndexRef
  );

  // isPlaying bridge effect — play/pause audio
  useEffect(() => {
    if (rateLimitUntilRef.current && Date.now() < rateLimitUntilRef.current) {
      if (!errorInfoRef.current || errorInfoRef.current.type !== 'rate_limited') {
        dispatch({ type: 'ERROR', error: { type: 'rate_limited', text: t('player.rate_limited', 'Google Drive tạm thời quá tải, đang thử lại...') } });
      }
      return;
    }
    if (isPlaying) {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      const active = getActiveAudio();
      if (active && !active.error) {
        safePlay(active).catch(e => {
          if (e.name === 'NotAllowedError') {
            dispatch({ type: 'BLOCKED', time: active.currentTime || null });
          } else if (e.name !== 'AbortError') {
            console.error('[Player] safePlay failed', e);
          }
        });
      }
    } else {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      const active = getActiveAudio();
      if (active) safePause(active);
    }
  }, [isPlaying, rateLimitUntilRef, dispatch, t, getActiveAudio]);

  // Ref syncing
  useEffect(() => {
    onTogglePlayRef.current = onTogglePlay;
    onNextTrackRef.current = handleNextClick;
    onPrevTrackRef.current = handlePrevClick;
    onTogglePlayModeRef.current = onTogglePlayMode;
    onToggleNowPlayingRef.current = onExpandNowPlaying;
  }, [onTogglePlay, onNextTrack, onPrevTrack, onTogglePlayMode, onExpandNowPlaying, handleNextClick, handlePrevClick]);

  const callbackRefs: CallbackRefs = {
    onTogglePlayRef,
    onNextTrackRef,
    onPrevTrackRef,
    onTogglePlayModeRef,
    onToggleNowPlayingRef,
    handleManualResumeRef,
    toastDismissRef: { current: null },
  };

  return {
    handleNextClick,
    handlePrevClick,
    handleManualResume,
    handleRetry,
    callbackRefs,
    isPlayingRef,
    errorInfoRef,
  };
}
