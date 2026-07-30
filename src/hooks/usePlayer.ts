import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { set as idbSet } from "../db/kv";
import { start as keepAwakeStart, stop as keepAwakeStop } from "tauri-plugin-keepawake-api";
import { Track } from "../App";
import { getTrackMetadata } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";
import { getPrefetchedStreamUrl } from "../utils/streamPrefetcher";
import { prefetchNextTrackAudio } from '../utils/nextTrackPrefetcher';
import { showErrorToast } from "../utils/simpleToast";
import { classifyPlayerError } from "./player/utils";
import { usePlayerSession } from "./player/usePlayerSession";
import { usePlayerQueue } from "./player/usePlayerQueue";

import { usePlayerStore } from "../store/playerStore";

export const usePlayer = (accessToken: string | null) => {
  const {
    currentTrack, setCurrentTrack,
    loadNonce, triggerReload,
    isPlaying, setIsPlaying,
    isDownloading, setIsDownloading,
    playMode, setPlayMode,
    originalQueue, setOriginalQueue,
    playbackQueue, setPlaybackQueue,
    bufferSeconds, setBufferSeconds
  } = usePlayerStore();
  
  const initialBufferRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Load session from IDB
  usePlayerSession(setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, setBufferSeconds, triggerReload);

  // Initialize queue handlers
  const { handleNextTrack, handlePrevTrack, handleTogglePlayMode, updateQueueContext } = usePlayerQueue(
    currentTrack, playbackQueue, originalQueue, playMode, setPlaybackQueue, setOriginalQueue, setPlayMode, 
    // handlePlayTrack will be passed via wrapper to avoid dependency issues
    (t, c, i, d, a) => handlePlayTrack(t, c, i, d, a)
  );

  // Persist buffer setting changes
  useEffect(() => {
    if (initialBufferRef.current) {
      initialBufferRef.current = false;
      return;
    }
    idbSet("drplay_buffer_seconds", bufferSeconds);
    invoke("update_buffer_settings", { seconds: bufferSeconds }).catch(e => {
      console.warn(`[usePlayer] buffer-settings-failed`, { seconds: bufferSeconds, error: classifyPlayerError(e).message });
    });
  }, [bufferSeconds]);

  // Keep system awake
  useEffect(() => {
    if (isPlaying) {
      keepAwakeStart({ display: false, idle: false, sleep: true }).catch(e => console.warn(`[usePlayer] keep-awake-failed`, classifyPlayerError(e)));
    } else {
      keepAwakeStop().catch(e => console.warn(`[usePlayer] keep-awake-release-failed`, classifyPlayerError(e)));
    }
  }, [isPlaying]);

  // Persist playMode
  useEffect(() => {
    idbSet('drplay_playmode', playMode).catch(e => console.warn(`[usePlayer] playmode-save-fail`, classifyPlayerError(e)));
  }, [playMode]);

  // Cleanup on logout
  useEffect(() => {
    const handleStop = () => {
      setCurrentTrack(null);
      setIsPlaying(false);
      setOriginalQueue([]);
      setPlaybackQueue([]);
    };
    window.addEventListener('player-stop', handleStop);
    return () => window.removeEventListener('player-stop', handleStop);
  }, []);

  const handlePlayTrack = useCallback(async (track: Track, contextQueue?: Track[], isNavigation: boolean = false, driveItems?: any[], activeTab?: string) => {
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

    const maybePrefetchNextTrack = (queue: Track[] | undefined, current: Track) => {
      if (!queue || queue.length < 2) return;
      const idx = queue.findIndex(item => item.queueItemId ? item.queueItemId === current.queueItemId : item.id === current.id);
      if (idx === -1 || idx >= queue.length - 1) return;
      const next = queue[idx + 1];
      const url = getPrefetchedStreamUrl(next.id);
      if (url) prefetchNextTrackAudio(url);
      else prefetchNextTrackAudio(`/drive-stream/${next.id}`);
    };

    const prefetchedUrl = getPrefetchedStreamUrl(targetTrack.id);

    try {
      const freshToken = await getValidToken(false, signal).catch(e => {
        if (e.name === 'AbortError') throw e;
        console.warn(`[usePlayer] token-refresh-fail`, classifyPlayerError(e));
        return null;
      });
      
      if (!freshToken) {
        setIsDownloading(false);
        return;
      }

      const streamUrl = prefetchedUrl || `/drive-stream/${targetTrack.id}`;
      setCurrentTrack({ ...targetTrack, streamUrl });
      triggerReload();
      setIsPlaying(true);
      setIsDownloading(false);

      maybePrefetchNextTrack(contextQueue, targetTrack);

      getTrackMetadata(targetTrack.id, freshToken, targetTrack.size, targetTrack.originalName, signal).then(metadata => {
        if (metadata.duration && !signal.aborted) {
          setCurrentTrack(prev => prev ? { ...prev, restoreDuration: metadata.duration } : prev);
        }
      }).catch(e => {
        if (e.name !== 'AbortError') {
           console.warn(`[usePlayer] metadata-prefetch-fail`, classifyPlayerError(e));
        }
      });
      
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.error(`[usePlayer] network-playback-error`, classifyPlayerError(e));
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
          } catch (e: any) {
            if (e.name !== 'AbortError') console.warn(`[usePlayer] bitrate-resume-fail`, classifyPlayerError(e));
          }

          const url = `/drive-stream/${currentTrack.id}`;
          
          setCurrentTrack(prev => prev ? { ...prev, streamUrl: url } : prev);
          triggerReload();
          setIsPlaying(true);
        } catch (e: any) {
          if (e.name === 'AbortError') return;
          console.error(`[usePlayer] stream-url-resume-fail`, classifyPlayerError(e));
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
    bufferSeconds, setBufferSeconds,
    handlePlayTrack, handleNextTrack, handlePrevTrack,
    handleTogglePlay, handleTogglePlayMode
  };
};
