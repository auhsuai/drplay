import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Track } from '../../../App';
import { getValidToken } from '../../../utils/apiClient';
import { captureError } from '../../../utils/errorLog';
import { PlayerAction } from '../types';
import type { TFunction } from 'i18next';
import { safePause } from '../../../utils/safeAudio';

const DRIVE_QUOTA_RETRY_MS = 30_000;

export function usePlaybackEventListeners(
  currentTrackRef: React.MutableRefObject<Track | null>,
  isPlayingRef: React.MutableRefObject<boolean>,
  errorInfoRef: React.MutableRefObject<{ type: string; text: string } | null>,
  errorPositionRef: React.MutableRefObject<number | null>,
  lastKnownPositionRef: React.MutableRefObject<number>,
  isTransitioningRef: React.MutableRefObject<boolean>,
  onTogglePlayRef: React.MutableRefObject<() => void>,
  dispatch: React.Dispatch<PlayerAction>,
  t: TFunction,
  getActiveAudio: () => HTMLAudioElement | null,
  loadNormalAudio: (track: Track, position: number | null) => Promise<HTMLAudioElement>,
  performRetry: (track: Track) => Promise<void>,
  audioRef: React.RefObject<HTMLAudioElement | null>,
  audioRef2: React.RefObject<HTMLAudioElement | null>,
  activeAudioIndexRef: React.MutableRefObject<0 | 1>
) {
  // Tauri listeners (token expired, drive quota)
  useEffect(() => {
    let cancelled = false;
    let rateLimitRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    const unlistenFns: (() => void)[] = [];

    listen('token-expired', async () => {
      console.warn('[Player] Token expired mid-stream, auto refreshing...');
      try {
        await getValidToken(true);
        if (cancelled) return;
        const track = currentTrackRef.current;
        const audioEl = getActiveAudio();
        if (track?.streamUrl && audioEl?.error) {
          const pos = audioEl.currentTime;
          const safePos = (pos && isFinite(pos) && pos > 0) ? pos : null;
          await loadNormalAudio(track, safePos);
        }
      } catch (err) {
        captureError({ level: 'error', source: 'playback-control', message: `Token refresh failed (${err instanceof Error ? err.name : 'unknown'})`, kind: 'auth' });
        if (cancelled) return;
        if (!errorInfoRef.current) {
          dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.auth_expired', 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại') } });
        }
      }
    }).then(fn => { unlistenFns.push(fn); }).catch(() => {
      captureError({ level: 'warn', source: 'playback-control', message: `Tauri event listener registration failed`, kind: 'listener' });
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
          if (cancelled) return;
        }
      }, DRIVE_QUOTA_RETRY_MS);
    }).then(fn => { unlistenFns.push(fn); }).catch(() => {
      captureError({ level: 'warn', source: 'playback-control', message: `Tauri event listener registration failed`, kind: 'listener' });
    });

    return () => {
      cancelled = true;
      if (rateLimitRetryTimeout) clearTimeout(rateLimitRetryTimeout);
      for (const fn of unlistenFns) fn();
    };
  }, [currentTrackRef, errorInfoRef, errorPositionRef, lastKnownPositionRef, dispatch, t, getActiveAudio, loadNormalAudio, performRetry]);

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
        captureError({ level: 'error', source: 'playback-control', message: `performRetry failed`, kind: 'retry' });
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [currentTrackRef, errorInfoRef, isPlayingRef, performRetry]);

  useEffect(() => {
    const handleOffline = () => {
      if (isPlayingRef.current && currentTrackRef.current) {
        errorPositionRef.current = Math.max(0, lastKnownPositionRef.current - 0.5);
      }
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, [currentTrackRef, isPlayingRef, errorPositionRef, lastKnownPositionRef]);

  // player-stop event
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
  }, [audioRef, audioRef2, activeAudioIndexRef]);

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
        return -1;
      }
    };

    checkDevices()
      .then(count => { if (!cancelled) lastDeviceCount = count; })
      .catch(() => {
        captureError({ level: 'warn', source: 'playback-control', message: `checkDevices failed`, kind: 'device' });
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
  }, [isPlayingRef, onTogglePlayRef]);

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
  }, [audioRef, audioRef2, isTransitioningRef, isPlayingRef, onTogglePlayRef]);
}
