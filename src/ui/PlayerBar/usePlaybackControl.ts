import { useEffect, useRef, useCallback } from 'react';
import { Track } from '../../App';
import { listen } from '@tauri-apps/api/event';
import { safePlay, safePause } from '../../utils/safeAudio';
import { getValidToken } from '../../utils/apiClient';
import { captureError } from '../../utils/errorLog';
import { PlayerAction, MAX_CONSECUTIVE_AUTO_SKIP, CallbackRefs } from './types';
import type { TFunction } from 'i18next';

// Debounce (ms) before clearing the manual next/prev transition lock so rapid
// double-fires aren't dropped and the lock can't stick if a click handler throws.
const TRANSITION_RESET_MS = 200;
// Delay (ms) before auto-retrying after a Drive quota-exceeded event.
const DRIVE_QUOTA_RETRY_MS = 30_000;

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

  // onNextTrackRef/onPrevTrackRef are created ONCE in PlayerBar.tsx (before
  // useAudioEngine is called, due to a circular hook ordering dependency) and
  // passed in here. They are the single source of truth for next/prev — synced
  // in the effect below and reused by mediaSession + callbackRefs so every
  // consumer (useAudioEngine auto-advance, useKeyboard, media keys) reads the
  // same ref object whose .current is always the current handleNextClick/handlePrevClick.
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
        // loadNormalAudio failed — handleAudioError will dispatch format_error again
      }
    }
    await performRetry(currentTrack);
  }, [currentTrack, performRetry, loadNormalAudio, dispatch, t]);

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
      captureError({ level: 'error', source: 'playback-control', message: `Manual resume failed (${errName ?? 'unknown'})`, kind: 'resume' });
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

  // Tauri listeners
  useEffect(() => {
    let rateLimitRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    const unlistenFns: (() => void)[] = [];

    listen('token-expired', async () => {
      console.warn('[Player] Token expired mid-stream, auto refreshing...');
      try {
        await getValidToken(true);
        // getValidToken -> update_stream_token wakes the Rust proxy waiter, which
        // retries the in-flight request with the fresh token. If that succeeds the
        // <audio> element never errors, so a reload here would only cause a needless
        // stutter. Only reload when the element has actually errored (proxy retry
        // timed out / still failing).
        const track = currentTrackRef.current;
        const audioEl = getActiveAudio();
        if (track?.streamUrl && audioEl?.error) {
          const pos = audioEl.currentTime;
          const safePos = (pos && isFinite(pos) && pos > 0) ? pos : null;
          await loadNormalAudio(track, safePos);
        }
      } catch (err) {
        captureError({ level: 'error', source: 'playback-control', message: `Token refresh on 'token-expired' failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'auth' });
        if (!errorInfoRef.current) {
          dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.auth_expired', 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại') } });
        }
      }
    }).then(fn => { unlistenFns.push(fn); }).catch((err) => {
      captureError({ level: 'warn', source: 'playback-control', message: `Tauri event listener registration failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'listener' });
    });

    listen('drive-quota-exceeded', () => {
      console.warn('[Player] Google Drive API quota exceeded');
      errorPositionRef.current = Math.max(0, lastKnownPositionRef.current - 0.5);
      dispatch({ type: 'ERROR', error: { type: 'drive_quota_exceeded', text: t('player.drive_quota_exceeded', 'Google Drive đã vượt quá giới hạn, đang thử lại...') } });
      if (rateLimitRetryTimeout) clearTimeout(rateLimitRetryTimeout);
      rateLimitRetryTimeout = setTimeout(async () => {
        const track = currentTrackRef.current;
        if (track?.streamUrl) {
          await performRetry(track);
        }
      }, DRIVE_QUOTA_RETRY_MS);
    }).then(fn => { unlistenFns.push(fn); }).catch((err) => {
      captureError({ level: 'warn', source: 'playback-control', message: `Tauri event listener registration failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'listener' });
    });

    return () => {
      if (rateLimitRetryTimeout) clearTimeout(rateLimitRetryTimeout);
      for (const fn of unlistenFns) fn();
    };
  }, []);

  // Online/Offline
  useEffect(() => {
    const handleOnline = async () => {
      const errType = errorInfoRef.current?.type;
      if (errType !== 'network_disconnected' && errType !== 'network_interrupted') return;
      if (!isPlayingRef.current) return;
      const track = currentTrackRef.current;
      if (!track?.streamUrl) return;
      try {
        await performRetry(track);
      } catch (err) {
        captureError({ level: 'error', source: 'playback-control', message: `performRetry on 'online' failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'retry' });
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  useEffect(() => {
    const handleOffline = () => {
      if (isPlayingRef.current && currentTrackRef.current) {
        errorPositionRef.current = Math.max(0, lastKnownPositionRef.current - 0.5);
      }
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, []);

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
  }, [isPlaying]);

  // Media Session API
  useEffect(() => {
    if ('mediaSession' in navigator && currentTrack) {
      const artwork: MediaImage[] = [];
      if ((currentTrack as any).coverUrl) {
        artwork.push({ src: (currentTrack as any).coverUrl, sizes: '512x512', type: 'image/jpeg' });
      } else {
        // Fallback to the app icon so the Windows taskbar media controls
        // (and other MediaSession consumers) always show artwork instead
        // of a blank placeholder when a track has no cover art.
        artwork.push({ src: '/sample.png', sizes: '512x512', type: 'image/png' });
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || currentTrack.originalName || 'Unknown Title',
        artist: currentTrack.artist || 'DrPlay',
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

  // player-stop
  useEffect(() => {
    const handlePlayerStop = () => {
      for (const el of [audioRef.current, audioRef2.current]) {
        if (el) {
          safePause(el);
          el.removeAttribute('src');
          el.load();
        }
      }
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
        navigator.mediaSession.metadata = null;
      }
      activeAudioIndexRef.current = 0;
    };
    window.addEventListener('player-stop', handlePlayerStop);
    return () => window.removeEventListener('player-stop', handlePlayerStop);
  }, []);

  // Bluetooth / Device disconnect auto-pause
  useEffect(() => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

    let lastDeviceCount = 0;
    let cancelled = false;
    const checkDevices = async (): Promise<number> => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === 'audiooutput').length;
      } catch {
        return -1; // permission denied or error
      }
    };

    checkDevices()
      .then(count => { if (!cancelled) lastDeviceCount = count; })
      .catch((err) => {
        captureError({ level: 'warn', source: 'playback-control', message: `checkDevices failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'device' });
      });

    const handleDeviceChange = async () => {
      const newCount = await checkDevices();
      if (newCount === -1 || lastDeviceCount === -1) {
        lastDeviceCount = newCount;
        return;
      }
      if (newCount < lastDeviceCount) {
        if (isPlayingRef.current) {
          onTogglePlayRef.current();
        }
      }
      lastDeviceCount = newCount;
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, []);

  // Audio focus sync (OS-level pause/play)
  useEffect(() => {
    const elements = [audioRef.current, audioRef2.current].filter(
      (el): el is HTMLAudioElement => el !== null
    );
    if (elements.length === 0) return;

    const handleSystemPause = () => {
      if (isTransitioningRef.current) return;
      if (isPlayingRef.current) {
        onTogglePlayRef.current();
      }
    };

    const handleSystemPlay = () => {
      if (isTransitioningRef.current) return;
      if (!isPlayingRef.current) {
        onTogglePlayRef.current();
      }
    };

    for (const el of elements) {
      el.addEventListener('pause', handleSystemPause);
      el.addEventListener('play', handleSystemPlay);
    }

    return () => {
      for (const el of elements) {
        el.removeEventListener('pause', handleSystemPause);
        el.removeEventListener('play', handleSystemPlay);
      }
    };
  }, []);

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
