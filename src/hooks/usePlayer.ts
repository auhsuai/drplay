import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { set as idbSet } from "../db/kv";
import { start as keepAwakeStart, stop as keepAwakeStop } from "tauri-plugin-keepawake-api";
import { Track } from "../App";
import { getTrackMetadata } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";
import { getPrefetchedStreamUrl } from "../utils/streamPrefetcher";
import { prefetchNextTrackAudio } from '../utils/nextTrackPrefetcher';
import { showErrorToast } from "../utils/simpleToast";
import { beginPlaybackIntent, isIntentStale, classifyPlayerError } from "./player/utils";
import { usePlayerSession } from "./player/usePlayerSession";
import { usePlayerQueue } from "./player/usePlayerQueue";

export const usePlayer = (accessToken: string | null) => {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const triggerReload = useCallback(() => setLoadNonce(n => n + 1), []);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [playMode, setPlayMode] = useState<'normal' | 'shuffle' | 'repeat-all' | 'repeat-one'>('normal');
  const [originalQueue, setOriginalQueue] = useState<Track[]>([]);
  const [playbackQueue, setPlaybackQueue] = useState<Track[]>([]);
  const [bufferSeconds, setBufferSeconds] = useState(1400);
  const initialBufferRef = useRef(true);

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

    if (currentTrack?.id === track.id && !isNavigation) {
      if (!isPlaying) setIsPlaying(true);
      return;
    }

    let targetTrack = track;
    if (!isNavigation) {
      targetTrack = updateQueueContext(track, contextQueue, driveItems, activeTab);
    }

    const myId = beginPlaybackIntent();
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
      const freshToken = await getValidToken().catch(e => {
        console.warn(`[usePlayer] token-refresh-fail`, classifyPlayerError(e));
        return null;
      });
      if (isIntentStale(myId)) return;
      
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

      getTrackMetadata(targetTrack.id, freshToken, targetTrack.size, targetTrack.originalName).then(metadata => {
        if (metadata.duration && !isIntentStale(myId)) {
          setCurrentTrack(prev => prev ? { ...prev, restoreDuration: metadata.duration } : prev);
        }
      }).catch(e => console.warn(`[usePlayer] metadata-prefetch-fail`, classifyPlayerError(e)));
      
    } catch (e) {
      if (isIntentStale(myId)) return;
      console.error(`[usePlayer] network-playback-error`, classifyPlayerError(e));
      showErrorToast("An exception occurred! Open Developer Tools (Ctrl+Shift+I) for details.");
    } finally {
      if (!isIntentStale(myId)) {
        setIsDownloading(false);
      }
    }
  }, [accessToken, currentTrack, isPlaying, triggerReload, updateQueueContext]);

  const handleTogglePlay = useCallback(async () => {
    if (currentTrack) {
      if (!currentTrack.streamUrl && !isPlaying) {
        const myId = beginPlaybackIntent();
        const prefetchedUrl = getPrefetchedStreamUrl(currentTrack.id);
        
        if (prefetchedUrl) {
          setCurrentTrack(prev => prev ? { ...prev, streamUrl: prefetchedUrl } : prev);
          triggerReload();
          setIsPlaying(true);
          return;
        }

        setIsDownloading(true);
        try {
          const freshToken = await getValidToken();
          if (isIntentStale(myId)) return;
          if (!freshToken) {
            setIsDownloading(false);
            return;
          }
          try {
            await getTrackMetadata(currentTrack.id, freshToken, currentTrack.size, currentTrack.originalName);
          } catch (e) {
            console.warn(`[usePlayer] bitrate-resume-fail`, classifyPlayerError(e));
          }

          const url = `/drive-stream/${currentTrack.id}`;
          if (isIntentStale(myId)) return;
          
          setCurrentTrack(prev => prev ? { ...prev, streamUrl: url } : prev);
          triggerReload();
          setIsPlaying(true);
        } catch (e) {
          if (isIntentStale(myId)) return;
          console.error(`[usePlayer] stream-url-resume-fail`, classifyPlayerError(e));
          showErrorToast("Could not start playback. Please try another track.");
        } finally {
          if (!isIntentStale(myId)) setIsDownloading(false);
        }
      } else {
        setIsPlaying(!isPlaying);
      }
    }
  }, [currentTrack, isPlaying, triggerReload]);

  return {
    currentTrack, setCurrentTrack, loadNonce, triggerReload,
    isPlaying, setIsPlaying, isDownloading, playbackQueue, playMode,
    bufferSeconds, setBufferSeconds,
    handlePlayTrack, handleNextTrack, handlePrevTrack,
    handleTogglePlay, handleTogglePlayMode
  };
};
