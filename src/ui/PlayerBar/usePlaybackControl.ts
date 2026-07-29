import { useEffect, useRef, useCallback } from 'react';
import { Track } from '../../App';
import { listen } from '@tauri-apps/api/event';
import { getValidToken } from '../../utils/apiClient';
import { captureError } from '../../utils/errorLog';
import { PlayerAction, MAX_CONSECUTIVE_AUTO_SKIP, CallbackRefs } from './types';
import { AudioEngineAPI } from './useAudioEngine';
import type { TFunction } from 'i18next';

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
  dispatch: React.Dispatch<PlayerAction>;
  t: TFunction;
  playerState: { error: { type: string; text: string } | null; manualResume: boolean; pendingResumeTime: number | null };
  engine: AudioEngineAPI;
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
  const { currentTrack, isPlaying, onTogglePlay, onNextTrack, onPrevTrack, onNextTrackRef, onPrevTrackRef, onTogglePlayMode, dispatch, t, playerState, engine, rateLimitUntilRef } = params;

  const { error: errorInfo, pendingResumeTime } = playerState;
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;
  const currentTrackIdRef = useRef(currentTrack?.id);

  const onTogglePlayRef = useRef(onTogglePlay);
  const onTogglePlayModeRef = useRef(onTogglePlayMode);
  const isPlayingRef = useRef(isPlaying);
  const errorInfoRef = useRef(errorInfo);
  const handleManualResumeRef = useRef<(() => void) | null>(null);

  const isTransitioningRef = useRef(false);
  const isAutoTransitioningRef = useRef(false);
  const consecutiveAutoSkipRef = useRef(0);
  const formatRetryCountRef = useRef(0);
  const lastKnownPositionRef = useRef(0);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    errorInfoRef.current = errorInfo;
  }, [errorInfo]);

  useEffect(() => {
    const trackId = currentTrackRef.current?.id;
    if (trackId && trackId !== currentTrackIdRef.current) {
      currentTrackIdRef.current = trackId;
      dispatch({ type: 'PLAY_SUCCESS' });
    }
  }, [currentTrack?.id]);

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
      captureError({ level: 'error', source: 'playback-control', message: `onNextTrack threw (${err instanceof Error ? err.name : 'unknown'})`, kind: 'navigation' });
    } finally {
      setTimeout(() => {
        if (isAutoSkip) {
          isAutoTransitioningRef.current = false;
        } else {
          isTransitioningRef.current = false;
        }
      }, TRANSITION_RESET_MS);
    }
  };

  const handlePrevClick = () => {
    if (isTransitioningRef.current) return;
    isTransitioningRef.current = true;
    try {
      onPrevTrack();
    } catch (err) {
      captureError({ level: 'error', source: 'playback-control', message: `onPrevTrack threw (${err instanceof Error ? err.name : 'unknown'})`, kind: 'navigation' });
    } finally {
      setTimeout(() => { isTransitioningRef.current = false; }, TRANSITION_RESET_MS);
    }
  };

  const handleRetry = useCallback(async () => {
    if (!currentTrack?.id) return;
    if (errorInfoRef.current?.type === 'format_error') {
      formatRetryCountRef.current += 1;
      if (formatRetryCountRef.current >= 2) {
        formatRetryCountRef.current = 0;
        dispatch({ type: 'ERROR', error: { type: 'format_error', text: t('player.seek_too_fast', 'Shouldn\'t seek too fast with lossless file type. Skipping...') } });
        onNextTrackRef.current();
        return;
      }
      dispatch({ type: 'CLEAR_ERROR' });
      try {
        await engine.play(currentTrack, 0);
        formatRetryCountRef.current = 0;
        return;
      } catch {
        // engine.play failed — dispatch format_error again
      }
    }
    await engine.play(currentTrack, 0);
  }, [currentTrack, engine, dispatch, t]);

  async function handleManualResume() {
    if (!currentTrack?.id || pendingResumeTime === null) return;
    const resumeTime = pendingResumeTime;
    if (!isFinite(resumeTime) || resumeTime < 0) {
      dispatch({ type: 'BLOCKED', time: null });
      return;
    }
    try {
      await engine.play(currentTrack, resumeTime);
      dispatch({ type: 'RESUMED' });
    } catch {
      captureError({ level: 'error', source: 'playback-control', message: 'Manual resume failed', kind: 'resume' });
      dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
    }
  }

  useEffect(() => {
    handleManualResumeRef.current = handleManualResume;
  }, [handleManualResume]);

  // Tauri listeners
  useEffect(() => {
    let cancelled = false;
    const unlistenFns: (() => void)[] = [];
    const registerUnlisten = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else unlistenFns.push(unlisten);
    };

    listen('token-expired', async () => {
      try {
        await getValidToken(true);
        const track = currentTrackRef.current;
        if (track?.id) {
          await engine.play(track, lastKnownPositionRef.current);
        }
      } catch (err) {
        captureError({ level: 'error', source: 'playback-control', message: `Token refresh on 'token-expired' failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'auth' });
        if (!errorInfoRef.current) {
          dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.auth_expired', 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại') } });
        }
      }
    }).then(registerUnlisten).catch((err) => {
      captureError({ level: 'warn', source: 'playback-control', message: `Tauri event listener registration failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'listener' });
    });

    return () => {
      cancelled = true;
      for (const fn of unlistenFns) fn();
    };
  }, [engine, dispatch, t]);

  // Online/Offline
  useEffect(() => {
    const handleOnline = async () => {
      const errType = errorInfoRef.current?.type;
      if (errType !== 'network_disconnected' && errType !== 'network_interrupted') return;
      if (!isPlayingRef.current) return;
      const track = currentTrackRef.current;
      if (!track?.id) return;
      try {
        await engine.play(track, Math.max(0, lastKnownPositionRef.current - 0.5));
      } catch (err) {
        captureError({ level: 'error', source: 'playback-control', message: `retry on 'online' failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'retry' });
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [engine]);

  useEffect(() => {
    const handleOffline = () => {
      if (isPlayingRef.current && currentTrackRef.current) {
        lastKnownPositionRef.current = Math.max(0, lastKnownPositionRef.current - 0.5);
      }
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, []);

  // isPlaying bridge effect — play/pause via native commands
  useEffect(() => {
    if (rateLimitUntilRef.current && Date.now() < rateLimitUntilRef.current) {
      if (!errorInfoRef.current || errorInfoRef.current.type !== 'rate_limited') {
        dispatch({ type: 'ERROR', error: { type: 'rate_limited', text: t('player.rate_limited', 'Google Drive tạm thời quá tải, đang thử lại...') } });
      }
      return;
    }
    if (isPlaying) {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      engine.resume().catch(() => {});
    } else {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      engine.pause().catch(() => {});
    }
  }, [isPlaying]);

  // Media Session API
  useEffect(() => {
    if ('mediaSession' in navigator && currentTrack) {
      const artwork: MediaImage[] = [{ src: '/sample.png', sizes: '512x512', type: 'image/png' }];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || currentTrack.originalName || 'Unknown Title',
        artist: 'DrPlay',
        artwork,
      });

      navigator.mediaSession.setActionHandler('play', () => onTogglePlayRef.current());
      navigator.mediaSession.setActionHandler('pause', () => onTogglePlayRef.current());
      navigator.mediaSession.setActionHandler('previoustrack', () => onPrevTrackRef.current());
      navigator.mediaSession.setActionHandler('nexttrack', () => onNextTrackRef.current());
    }

    return () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
      }
    };
  }, [currentTrack]);

  // Ref syncing
  useEffect(() => {
    onTogglePlayRef.current = onTogglePlay;
    onNextTrackRef.current = handleNextClick;
    onPrevTrackRef.current = handlePrevClick;
    onTogglePlayModeRef.current = onTogglePlayMode;
  }, [onTogglePlay, onNextTrack, onPrevTrack, onTogglePlayMode, handleNextClick, handlePrevClick]);

  const callbackRefs: CallbackRefs = {
    onTogglePlayRef,
    onNextTrackRef,
    onPrevTrackRef,
    onTogglePlayModeRef,
    handleManualResumeRef,
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
