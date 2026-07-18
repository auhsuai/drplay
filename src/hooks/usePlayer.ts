import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { get, set as idbSet } from "idb-keyval";
import { start as keepAwakeStart, stop as keepAwakeStop } from "tauri-plugin-keepawake-api";
import { Track } from "../App"; // Reuse Track type from App.tsx
import { getTrackMetadata } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";
import { getPrefetchedStreamUrl } from "../utils/streamPrefetcher";
import { prefetchNextTrackAudio, clearNextTrackPrefetches } from '../utils/nextTrackPrefetcher';


const playRequestIdRef = { current: 0 };

function beginPlaybackIntent(): number {
  return ++playRequestIdRef.current;
}

function isIntentStale(myId: number): boolean {
  return myId !== playRequestIdRef.current;
}

function classifyPlayerError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "Unknown error";
  }
  if (typeof err === "string") return err;
  return "Unknown error";
}

export const usePlayer = (accessToken: string | null) => {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const triggerReload = () => setLoadNonce(n => n + 1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [playMode, setPlayMode] = useState<'normal' | 'shuffle' | 'repeat-all' | 'repeat-one'>('normal');
  const [originalQueue, setOriginalQueue] = useState<Track[]>([]);
  const [playbackQueue, setPlaybackQueue] = useState<Track[]>([]);
  const [bufferSeconds, setBufferSeconds] = useState(1400);
  const initialBufferRef = useRef(true);

  // Persist buffer setting changes to IndexedDB and Rust backend
  useEffect(() => {
    if (initialBufferRef.current) {
      initialBufferRef.current = false;
      return;
    }
    idbSet("drplay_buffer_seconds", bufferSeconds);
    invoke("update_buffer_settings", { seconds: bufferSeconds }).catch(e =>
      console.warn(`[usePlayer] buffer-settings-failed`, classifyPlayerError(e))
    );
  }, [bufferSeconds]);

  // Keep system awake while playing
  useEffect(() => {
    if (isPlaying) {
      keepAwakeStart({ display: false, idle: false, sleep: true }).catch(e =>
        console.warn(`[usePlayer] keep-awake-failed`, classifyPlayerError(e))
      );
    } else {
      keepAwakeStop().catch(e =>
        console.warn(`[usePlayer] keep-awake-release-failed`, classifyPlayerError(e))
      );
    }
  }, [isPlaying]);

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

  // Load last session and buffer
  useEffect(() => {
    const loadSession = async () => {
      const myId = beginPlaybackIntent();
      try {
        const lastSessionStr = localStorage.getItem("drplay_last_session");
        let lastSession;
        if (lastSessionStr) {
          try {
            lastSession = JSON.parse(lastSessionStr);
          } catch (e) {
            console.warn(`[usePlayer] session-corrupt`, classifyPlayerError(e));
            lastSession = await get("drplay_last_session");
          }
        } else {
          lastSession = await get("drplay_last_session");
        }

        const rawBuffer = await get("drplay_buffer_seconds");
        const validBuffer = (typeof rawBuffer === "number" && Number.isFinite(rawBuffer) && rawBuffer > 0)
          ? rawBuffer
          : undefined;
        if (validBuffer !== undefined) setBufferSeconds(validBuffer);

        if (lastSession && lastSession.track) {
          if (isIntentStale(myId)) {
            return;
          }
          let streamUrl = "";
          const freshToken = await getValidToken();
          if (isIntentStale(myId)) return;
          
          if (freshToken) {
            try {
              streamUrl = getPrefetchedStreamUrl(lastSession.track.id) || '';
              if (!streamUrl) {
                const ext = lastSession.track.originalName?.split('.').pop()?.toLowerCase();
                streamUrl = await invoke<string>("get_stream_url", { 
                  fileId: lastSession.track.id, 
                  bitrate: lastSession.track.bitrate, 
                  bufferSeconds: validBuffer ?? 1400,
                  ext
                });
              }
            } catch (e) {
              console.warn(`[usePlayer] session-restore-stream-fail`, classifyPlayerError(e));
            }
          }
          if (isIntentStale(myId)) return;

          const savedQueue = await get('drplay_queue');
          if (isIntentStale(myId)) return;

          const restoredTrack: Track = {
            ...lastSession.track,
            streamUrl,
            restoreTime: lastSession.time,
            restoreDuration: lastSession.duration,
          };
          setCurrentTrack(restoredTrack);

          if (savedQueue && Array.isArray(savedQueue) && savedQueue.length > 0) {
            setOriginalQueue(savedQueue);
            setPlaybackQueue([...savedQueue]);
          } else {
            setPlaybackQueue([restoredTrack]);
          }
          triggerReload();
        }
      } catch (e) {
        console.error(`[usePlayer] session-load-failed`, classifyPlayerError(e));
      }
    };
    loadSession();
  }, []);

  const handlePlayTrack = async (track: Track, contextQueue?: Track[], isNavigation: boolean = false, driveItems?: any[], activeTab?: string) => {

    if (!accessToken) return;

    if (currentTrack?.id === track.id && !isNavigation) {
      if (!isPlaying) {
        setIsPlaying(true);
      }
      return;
    }

    // Update playback queue based on context
    let targetTrack = { ...track };
    if (!isNavigation) {
      let newOriginalQueue: Track[] = [];
      if (contextQueue && contextQueue.length > 0) {
        newOriginalQueue = contextQueue.map(t => ({...t, queueItemId: t.queueItemId || crypto.randomUUID()}));
      } else if (activeTab === "My Drive" && driveItems) {
        newOriginalQueue = driveItems.filter(item => !item.isFolder && item.trackInfo).map(item => ({...item.trackInfo!, queueItemId: item.trackInfo!.queueItemId || crypto.randomUUID()}));
      }

      if (newOriginalQueue.length > 0) {
        setOriginalQueue(newOriginalQueue);
        idbSet('drplay_queue', newOriginalQueue).catch(e =>
          console.warn(`[usePlayer] queue-save-fail`, classifyPlayerError(e))
        );
        if (playMode === 'shuffle') {
          const shuffled = [...newOriginalQueue];
          const trackIndex = shuffled.findIndex(t => t.id === track.id);
          let currentTrackInQueue = shuffled[0];
          if (trackIndex !== -1) {
            currentTrackInQueue = shuffled[trackIndex];
            shuffled.splice(trackIndex, 1);
          } else {
             currentTrackInQueue = {...track, queueItemId: crypto.randomUUID()};
          }

          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          shuffled.unshift(currentTrackInQueue);
          setPlaybackQueue(shuffled);
          targetTrack = currentTrackInQueue;
        } else {
          setPlaybackQueue(newOriginalQueue);
          const trackIndex = newOriginalQueue.findIndex(t => t.id === track.id);
          if (trackIndex !== -1) {
            targetTrack = newOriginalQueue[trackIndex];
          } else {
            targetTrack = {...track, queueItemId: crypto.randomUUID()};
          }
        }
      } else {
        if (!targetTrack.queueItemId) {
          targetTrack = {...targetTrack, queueItemId: crypto.randomUUID()};
        }
        setPlaybackQueue([targetTrack]);
        idbSet('drplay_queue', []).catch(e =>
          console.warn(`[usePlayer] queue-clear-fail`, classifyPlayerError(e))
        );
      }
    }

    const myId = beginPlaybackIntent();

    setIsPlaying(false);
    setIsDownloading(true);

    const maybePrefetchNextTrack = (queue: Track[] | undefined, current: Track) => {
      if (!queue || queue.length < 2) return;
      const idx = queue.findIndex(
        item => item.queueItemId ? item.queueItemId === current.queueItemId : item.id === current.id
      );
      if (idx === -1 || idx >= queue.length - 1) return;
      const next = queue[idx + 1];
      const url = getPrefetchedStreamUrl(next.id);
      if (url) {
        prefetchNextTrackAudio(url);
      } else {
        const ext = next.originalName?.split('.').pop()?.toLowerCase();
        invoke<string>("get_stream_url", { fileId: next.id, ext })
          .then(url => { if (url) prefetchNextTrackAudio(url); })
          .catch(err => { console.warn('[usePlayer] next-track-prefetch-fail', err); });
      }
    };

    const prefetchedUrl = getPrefetchedStreamUrl(targetTrack.id);

    if (prefetchedUrl) {
      // Ensure the Rust proxy has a valid (non-expired) token BEFORE the <audio>
      // element starts loading the stream. Otherwise a token that expired while
      // idle/paused causes the proxy to 401 -> the audio errors -> a spurious
      // network banner. getValidToken() is cheap when not expired and refreshes
      // (awaiting update_stream_token) when it is.
      const freshToken = await getValidToken().catch(e => {
        console.warn(`[usePlayer] token-refresh-prefetch-fail`, classifyPlayerError(e));
        return null;
      });
      if (isIntentStale(myId)) return;
      if (!freshToken) {
        setIsDownloading(false);
        return;
      }

      setCurrentTrack({ ...targetTrack, streamUrl: prefetchedUrl });
      triggerReload();
      setIsPlaying(true);
      setIsDownloading(false);

      maybePrefetchNextTrack(contextQueue, targetTrack);

      getTrackMetadata(targetTrack.id, freshToken, targetTrack.size, targetTrack.originalName).then(metadata => {
        if (metadata.duration && !isIntentStale(myId)) {
          setCurrentTrack(prev => prev ? { ...prev, restoreDuration: metadata.duration } : prev);
        }
      }).catch(e => console.warn(`[usePlayer] metadata-prefetch-fail`, classifyPlayerError(e)));
      return;
    }

    try {
      const freshToken = await getValidToken();
      if (isIntentStale(myId)) return;
      if (!freshToken) {
        setIsDownloading(false);
        return;
      }

      const ext = targetTrack.originalName?.split('.').pop()?.toLowerCase();
      const streamUrl = await invoke<string>("get_stream_url", {
        fileId: targetTrack.id,
        bufferSeconds,
        ext,
      });

      if (isIntentStale(myId)) return;
      if (!streamUrl) {
        setIsDownloading(false);
        return;
      }

      setCurrentTrack({ ...targetTrack, streamUrl });
      triggerReload();
      setIsPlaying(true);
      setIsDownloading(false);

      maybePrefetchNextTrack(contextQueue, targetTrack);

      getTrackMetadata(targetTrack.id, freshToken, targetTrack.size, targetTrack.originalName)
        .then(metadata => {
          if (metadata.duration && !isIntentStale(myId)) {
            setCurrentTrack(prev => prev ? { ...prev, restoreDuration: metadata.duration } : prev);
          }
        })
        .catch(e => console.warn(`[usePlayer] metadata-fetch-fail`, classifyPlayerError(e)));
    } catch (e) {
      if (isIntentStale(myId)) return;
      console.error(`[usePlayer] network-playback-error`, classifyPlayerError(e));
      alert("An exception occurred! Open Developer Tools (Ctrl+Shift+I) for details.");
    } finally {
      if (!isIntentStale(myId)) {
        setIsDownloading(false);
      }
    }
  };

  const handleNextTrack = () => {
    if (!currentTrack || playbackQueue.length === 0) return;

    const currentIndex = playbackQueue.findIndex(item => item.queueItemId ? (item.queueItemId === currentTrack.queueItemId) : (item.id === currentTrack.id));
    if (currentIndex === -1) {
      console.warn(`[usePlayer] handleNextTrack: current track not found in playbackQueue`, { currentTrackId: currentTrack?.id });
      return;
    }

    if (currentIndex < playbackQueue.length - 1) {
      handlePlayTrack(playbackQueue[currentIndex + 1], undefined, true);
    } else {
      if (playMode === 'repeat-all' || playMode === 'shuffle') {
        handlePlayTrack(playbackQueue[0], undefined, true);
      }
    }
  };

  const handlePrevTrack = () => {
    if (!currentTrack || playbackQueue.length === 0) return;

    const currentIndex = playbackQueue.findIndex(item => item.queueItemId ? (item.queueItemId === currentTrack.queueItemId) : (item.id === currentTrack.id));
    if (currentIndex === -1) {
      console.warn(`[usePlayer] handlePrevTrack: current track not found in playbackQueue`, { currentTrackId: currentTrack?.id });
      return;
    }

    if (currentIndex > 0) {
      handlePlayTrack(playbackQueue[currentIndex - 1], undefined, true);
    } else {
      if (playMode === 'repeat-all' || playMode === 'shuffle') {
        handlePlayTrack(playbackQueue[playbackQueue.length - 1], undefined, true);
      }
    }
  };

  const handleTogglePlay = async () => {
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
          let bitrate = undefined;
          const freshToken = await getValidToken();
          if (isIntentStale(myId)) return;
          
          if (!freshToken) {
            setIsDownloading(false);
            return;
          }
          try {
            const metadata = await getTrackMetadata(currentTrack.id, freshToken, currentTrack.size, currentTrack.originalName);
            if (isIntentStale(myId)) return;
            bitrate = metadata.bitrate;
          } catch (e) {
            console.warn(`[usePlayer] bitrate-resume-fail`, classifyPlayerError(e));
          }

          const ext = currentTrack.originalName?.split('.').pop()?.toLowerCase();
          const url = await invoke<string>("get_stream_url", { fileId: currentTrack.id, bitrate, bufferSeconds, ext });
          if (isIntentStale(myId)) return;
          
          setCurrentTrack(prev => prev ? { ...prev, streamUrl: url } : prev);
          triggerReload();
          setIsPlaying(true);
        } catch (e) {
          if (isIntentStale(myId)) return;
          console.error(`[usePlayer] stream-url-resume-fail`, classifyPlayerError(e));
          alert("Could not start playback. Please try another track.");
        } finally {
          if (!isIntentStale(myId)) setIsDownloading(false);
        }
      } else {
        setIsPlaying(!isPlaying);
      }
    }
  };

  const handleTogglePlayMode = () => {
    const queue = originalQueue;
    const track = currentTrack;
    setPlayMode(prev => {
      const nextMode = prev === 'normal' ? 'shuffle' : (prev === 'shuffle' ? 'repeat-all' : (prev === 'repeat-all' ? 'repeat-one' : 'normal'));

      if (nextMode === 'shuffle') {
        if (queue.length > 0 && track) {
          const shuffled = [...queue];
          const trackIndex = shuffled.findIndex(t => t.queueItemId ? (t.queueItemId === track.queueItemId) : (t.id === track.id));
          let currentTrackInQueue = track;
          if (trackIndex !== -1) {
            currentTrackInQueue = shuffled[trackIndex];
            shuffled.splice(trackIndex, 1);
          }

          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          shuffled.unshift(currentTrackInQueue);
          setPlaybackQueue(shuffled);
        }
      } else if (prev === 'shuffle') {
        setPlaybackQueue([...queue]);
      }

      return nextMode;
    });
  };

  return {
    currentTrack,
    setCurrentTrack,
    loadNonce,
    triggerReload,
    isPlaying,
    setIsPlaying,
    isDownloading,
    playbackQueue,
    playMode,
    bufferSeconds,
    setBufferSeconds,
    handlePlayTrack,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlay,
    handleTogglePlayMode
  };
};
