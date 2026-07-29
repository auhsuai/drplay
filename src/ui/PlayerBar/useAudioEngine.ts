import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Track } from '../../App';

export interface PlaybackState {
  isPlaying: boolean;
  position: number;
  duration: number;
  fileId: string | null;
}

export interface AudioEngineAPI {
  play: (track: Track, position?: number) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (position: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  stop: () => Promise<void>;
  playbackState: PlaybackState;
}

export function useAudioEngine(): AudioEngineAPI {
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    isPlaying: false,
    position: 0,
    duration: 0,
    fileId: null,
  });

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;

    listen<{ position: number; duration: number; is_playing: boolean; file_id?: string }>(
      'playback_time_update',
      (event) => {
        if (cancelled) return;
        setPlaybackState({
          position: event.payload.position,
          duration: event.payload.duration,
          isPlaying: event.payload.is_playing,
          fileId: event.payload.file_id ?? null,
        });
      }
    ).then(fn => {
      if (cancelled) { fn(); return; }
      unlistenFn = fn;
    });

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, []);

  const play = useCallback(async (track: Track, position: number = 0) => {
    const ext = track.originalName?.split('.').pop()?.toLowerCase();
    const dur = track.restoreDuration ?? null;
    await invoke('native_play', { fileId: track.id, position, ext: ext ?? null, duration: dur });
  }, []);

  const pause = useCallback(async () => {
    await invoke('native_pause');
  }, []);

  const resume = useCallback(async () => {
    await invoke('native_resume');
  }, []);

  const seek = useCallback(async (position: number) => {
    await invoke('native_seek', { position });
  }, []);

  const setVolume = useCallback(async (volume: number) => {
    await invoke('native_set_volume', { volume });
  }, []);

  const stop = useCallback(async () => {
    await invoke('native_stop');
    setPlaybackState({ isPlaying: false, position: 0, duration: 0, fileId: null });
  }, []);

  return { play, pause, resume, seek, setVolume, stop, playbackState };
}
