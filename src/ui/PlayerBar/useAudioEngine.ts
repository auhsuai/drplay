import { useState, useEffect, useCallback, useRef } from 'react';
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
  seek: (position: number, debounceMs?: number) => Promise<void>;
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

  // Track the most recently requested file ID to filter stale ticker events
  // from the previous track (common during track transitions when a ticker
  // event with the old file_id arrives before cmd_play updates the Rust state).
  const lastPlayedFileId = useRef<string | null>(null);
  const isSeekingRef = useRef(false);
  const seekDebounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekLockoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;

    listen<{ position: number; duration: number; is_playing: boolean; file_id?: string }>(
      'playback_time_update',
      (event) => {
        if (cancelled) return;
        const fileId = event.payload.file_id ?? null;
        // Ignore stale events from a previous track
        if (lastPlayedFileId.current && fileId !== lastPlayedFileId.current) {
          return;
        }
        if (isSeekingRef.current) {
          return;
        }
        setPlaybackState({
          position: event.payload.position,
          duration: event.payload.duration,
          isPlaying: event.payload.is_playing,
          fileId,
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
    // Set immediately so the ticker listener can reject stale events even
    // before the Tauri IPC round-trip completes.
    lastPlayedFileId.current = track.id;
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

  const seek = useCallback(async (position: number, debounceMs: number = 0) => {
    isSeekingRef.current = true;
    setPlaybackState(prev => ({ ...prev, position }));

    if (seekDebounceTimeoutRef.current) clearTimeout(seekDebounceTimeoutRef.current);

    const execute = async () => {
      try {
        await invoke('native_seek', { position });
      } catch (e) {
        console.error('[seek]', e);
      } finally {
        if (seekLockoutTimeoutRef.current) clearTimeout(seekLockoutTimeoutRef.current);
        seekLockoutTimeoutRef.current = setTimeout(() => {
          isSeekingRef.current = false;
        }, 500);
      }
    };

    if (debounceMs > 0) {
      seekDebounceTimeoutRef.current = setTimeout(execute, debounceMs);
    } else {
      execute();
    }
  }, []);

  const setVolume = useCallback(async (volume: number) => {
    await invoke('native_set_volume', { volume });
  }, []);

  const stop = useCallback(async () => {
    await invoke('native_stop');
    lastPlayedFileId.current = null;
    setPlaybackState({ isPlaying: false, position: 0, duration: 0, fileId: null });
  }, []);

  return { play, pause, resume, seek, setVolume, stop, playbackState };
}
