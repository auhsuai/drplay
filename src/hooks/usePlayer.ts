import { useEffect, useRef, useCallback } from "react";
import { useShallow } from 'zustand/react/shallow';
import { set as idbSet } from "../db/kv";
import { start as keepAwakeStart, stop as keepAwakeStop } from "tauri-plugin-keepawake-api";
import { Track } from "../App";
import { recordPlay } from "../utils/history";
import { getTrackMetadata } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";
import { getPrefetchedStreamUrl } from "../utils/streamPrefetcher";
import { prefetchNextTrackAudio } from '../utils/nextTrackPrefetcher';
import { showErrorToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";
import { usePlayerSession } from "./player/usePlayerSession";
import { usePlayerQueue } from "./player/usePlayerQueue";

import { usePlayerStore } from "../store/playerStore";
import { AudioController } from "../lib/AudioController";

const PLAYER_STOP_EVENT = 'player-stop';
const DRIVE_STREAM_PREFIX = '/drive-stream/';

export const usePlayer = (accessToken: string | null) => {
  const {
    currentTrack, setCurrentTrack,
    loadNonce, triggerReload,
    isPlaying, setIsPlaying,
    isDownloading, setIsDownloading,
    playMode, setPlayMode,
    originalQueue, setOriginalQueue,
    playbackQueue, setPlaybackQueue,
  } = usePlayerStore(useShallow(state => ({
    currentTrack: state.currentTrack, setCurrentTrack: state.setCurrentTrack,
    loadNonce: state.loadNonce, triggerReload: state.triggerReload,
    isPlaying: state.isPlaying, setIsPlaying: state.setIsPlaying,
    isDownloading: state.isDownloading, setIsDownloading: state.setIsDownloading,
    playMode: state.playMode, setPlayMode: state.setPlayMode,
    originalQueue: state.originalQueue, setOriginalQueue: state.setOriginalQueue,
    playbackQueue: state.playbackQueue, setPlaybackQueue: state.setPlaybackQueue,
  })));
  
  const abortControllerRef = useRef<AbortController | null>(null);

  // Load session from IDB
  usePlayerSession(setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, triggerReload);

  // Initialize queue handlers
  const { handleNextTrack, handlePrevTrack, handleTogglePlayMode, updateQueueContext } = usePlayerQueue(
    currentTrack, playbackQueue, originalQueue, playMode, setPlaybackQueue, setOriginalQueue, setPlayMode, 
    // handlePlayTrack will be passed via wrapper to avoid dependency issues
    (t, c, i, d, a) => handlePlayTrack(t, c, i, d, a)
  );

  // Keep system awake
  useEffect(() => {
    if (isPlaying) {
      keepAwakeStart({ display: false, idle: false, sleep: true }).catch((e: unknown) => { captureError({ level: 'warn', source: 'usePlayer', message: `keep-awake-failed: ${e instanceof Error ? e.message : String(e)}` }); });
    } else {
      keepAwakeStop().catch((e: unknown) => { captureError({ level: 'warn', source: 'usePlayer', message: `keep-awake-release-failed: ${e instanceof Error ? e.message : String(e)}` }); });
    }
  }, [isPlaying]);

  // Persist playMode
  useEffect(() => {
    idbSet('drplay_playmode', playMode).catch((e: unknown) => { captureError({ level: 'warn', source: 'usePlayer', message: `playmode-save-fail: ${e instanceof Error ? e.message : String(e)}` }); });
  }, [playMode]);

  // Cleanup on logout
  useEffect(() => {
    const handleStop = () => {
      // B3: release the real audio elements (buffers, src, pending retry)
      // before clearing the store state.
      AudioController.getInstance().release();
      setCurrentTrack(null);
      setIsPlaying(false);
      setOriginalQueue([]);
      setPlaybackQueue([]);
    };
    window.addEventListener(PLAYER_STOP_EVENT, handleStop);
    return () => window.removeEventListener(PLAYER_STOP_EVENT, handleStop);
  }, []);

  const handlePlayTrack = useCallback(async (track: Track, contextQueue?: Track[], isNavigation: boolean = false, driveItems?: unknown[], activeTab?: string) => {
    if (!accessToken) return;

    const { currentTrack, isPlaying } = usePlayerStore.getState();

    if (currentTrack?.id === track.id && !isNavigation) {
      if (!isPlaying) setIsPlaying(true);
      return;
    }

    let targetTrack = track;
    if (!isNavigation) {
      targetTrack = updateQueueContext(track, contextQueue, driveItems, activeTab);
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const signal = abortController.signal;

    setIsPlaying(false);
    setIsDownloading(true);

    // Fire-and-forget: prefetch the next track's audio for gapless playback.
    const scheduleNextTrackPrefetch = (queue: Track[] | undefined, current: Track): void => {
      if (!queue || queue.length < 2) return;
      const idx = queue.findIndex(item => item.queueItemId ? item.queueItemId === current.queueItemId : item.id === current.id);
      if (idx === -1 || idx >= queue.length - 1) return;
      const next = queue[idx + 1];
      const url = getPrefetchedStreamUrl(next.id);
      if (url) prefetchNextTrackAudio(url);
      else prefetchNextTrackAudio(`${DRIVE_STREAM_PREFIX}${next.id}`);
    };

    const prefetchedUrl = getPrefetchedStreamUrl(targetTrack.id);

    try {
      const freshToken = await getValidToken(false, signal).catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        captureError({ level: 'warn', source: 'usePlayer', message: `token-refresh-fail: ${e instanceof Error ? e.message : String(e)}` });
        return null;
      });
      
      if (!freshToken) {
        setIsDownloading(false);
        return;
      }

      const streamUrl = prefetchedUrl || `${DRIVE_STREAM_PREFIX}${targetTrack.id}`;
      setCurrentTrack({ ...targetTrack, streamUrl });
      triggerReload();
      setIsPlaying(true);
      setIsDownloading(false);

      recordPlay(targetTrack).catch((e: unknown) => { captureError({ level: 'warn', source: 'usePlayer', message: `recordPlay-fail: ${e instanceof Error ? e.message : String(e)}` }); });

      scheduleNextTrackPrefetch(contextQueue, targetTrack);

      void (async () => {
        try {
          const metadata = await getTrackMetadata(targetTrack.id, freshToken, targetTrack.size, targetTrack.originalName, signal);
          if (metadata.duration && !signal.aborted) {
            setCurrentTrack(prev => prev ? { ...prev, restoreDuration: metadata.duration } : prev);
          }
        } catch (e: unknown) {
          if (!(e instanceof DOMException && e.name === 'AbortError')) {
            captureError({ level: 'warn', source: 'usePlayer', message: `metadata-prefetch-fail: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
      })();
      
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      captureError({ level: 'error', source: 'usePlayer', message: `network-playback-error: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast("An exception occurred! Open Developer Tools (Ctrl+Shift+I) for details.");
    } finally {
      if (!signal.aborted) {
        setIsDownloading(false);
      }
    }
  }, [accessToken, triggerReload, updateQueueContext, setIsPlaying, setIsDownloading, setCurrentTrack]);

  const handleTogglePlay = useCallback(async () => {
    if (currentTrack) {
      if (!currentTrack.streamUrl && !isPlaying) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        const signal = abortController.signal;

        const prefetchedUrl = getPrefetchedStreamUrl(currentTrack.id);
        
        if (prefetchedUrl) {
          setCurrentTrack(prev => prev ? { ...prev, streamUrl: prefetchedUrl } : prev);
          triggerReload();
          setIsPlaying(true);
          return;
        }

        setIsDownloading(true);
        try {
          const freshToken = await getValidToken(false, signal);
          if (!freshToken) {
            setIsDownloading(false);
            return;
          }
          try {
            await getTrackMetadata(currentTrack.id, freshToken, currentTrack.size, currentTrack.originalName, signal);
          } catch (e: unknown) {
            if (!(e instanceof DOMException && e.name === 'AbortError')) {
              captureError({ level: 'warn', source: 'usePlayer', message: `bitrate-resume-fail: ${e instanceof Error ? e.message : String(e)}` });
            }
          }

          const url = `${DRIVE_STREAM_PREFIX}${currentTrack.id}`;
          
          setCurrentTrack(prev => prev ? { ...prev, streamUrl: url } : prev);
          triggerReload();
          setIsPlaying(true);
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          captureError({ level: 'error', source: 'usePlayer', message: `stream-url-resume-fail: ${e instanceof Error ? e.message : String(e)}` });
          showErrorToast("Could not start playback. Please try another track.");
        } finally {
          if (!signal.aborted) setIsDownloading(false);
        }
      } else {
        const { isPlaying: currentIsPlaying } = usePlayerStore.getState();
        setIsPlaying(!currentIsPlaying);
      }
    }
  }, [currentTrack, triggerReload, setIsDownloading, setCurrentTrack, setIsPlaying]);

  return {
    currentTrack, setCurrentTrack, loadNonce, triggerReload,
    isPlaying, setIsPlaying, isDownloading, playbackQueue, playMode,
    handlePlayTrack, handleNextTrack, handlePrevTrack,
    handleTogglePlay, handleTogglePlayMode
  };
};
