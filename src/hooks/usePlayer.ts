import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { get } from "idb-keyval";
import { Track } from "../App"; // Reuse Track type from App.tsx
import { getTrackMetadata } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";


const playRequestIdRef = { current: 0 };

function beginPlaybackIntent(): number {
  return ++playRequestIdRef.current;
}

function isIntentStale(myId: number): boolean {
  return myId !== playRequestIdRef.current;
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

  // Load last session and buffer
  useEffect(() => {
    const loadSession = async () => {
      const myId = beginPlaybackIntent();
      try {
        const lastSessionStr = localStorage.getItem("drplay_last_session");
        let lastSession;
        if (lastSessionStr) {
          lastSession = JSON.parse(lastSessionStr);
        } else {
          lastSession = await get("drplay_last_session");
        }

        const storedBuffer = await get("drplay_buffer_seconds");
        if (storedBuffer) setBufferSeconds(storedBuffer as number);

        if (lastSession && lastSession.track) {
          if (isIntentStale(myId)) {
            console.debug('[Session] Restore cancelled because user pressed Play');
            return;
          }
          let streamUrl = "";
          const freshToken = await getValidToken();
          if (isIntentStale(myId)) return;
          
          if (freshToken) {
            try {
              const ext = lastSession.track.originalName?.split('.').pop()?.toLowerCase();
              streamUrl = await invoke<string>("get_stream_url", { 
                fileId: lastSession.track.id, 
                bitrate: lastSession.track.bitrate, 
                bufferSeconds: storedBuffer || 1400,
                ext
              });
            } catch (e) {
              console.warn("Failed to invoke get_stream_url on session restore", e);
            }
          }
          if (isIntentStale(myId)) return;

          setCurrentTrack({
            ...lastSession.track,
            streamUrl,
            restoreTime: lastSession.time,
            restoreDuration: lastSession.duration
          });
          triggerReload();
        }
      } catch (e) {
        console.error("Failed to load player session", e);
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
      }
    }

    const myId = beginPlaybackIntent();


    setIsPlaying(false);
    setIsDownloading(true);

    try {
      let accurateMetaDuration = undefined;
      const freshToken = await getValidToken();
      if (isIntentStale(myId)) return;
      if (!freshToken) {
        setIsDownloading(false);
        return;
      }
      
      try {
        const metadata = await getTrackMetadata(targetTrack.id, freshToken, targetTrack.size, targetTrack.originalName);
        if (isIntentStale(myId)) return;
        if (metadata.duration) {
           accurateMetaDuration = metadata.duration;
        }
      } catch (e) {
        console.warn("Could not get bitrate for buffer calculation", e);
      }

      const ext = targetTrack.originalName?.split('.').pop()?.toLowerCase();
      const streamUrl = await invoke<string>("get_stream_url", { fileId: targetTrack.id, duration: accurateMetaDuration, bufferSeconds, ext });
      if (isIntentStale(myId)) {
        console.debug(`[Player] Discard stale result for ${targetTrack.id}`);
        return;
      }

      setCurrentTrack({ 
        ...targetTrack, 
        streamUrl, 
        restoreDuration: accurateMetaDuration || targetTrack.restoreDuration 
      });
      triggerReload();
      setIsPlaying(true);
    } catch (e) {
      if (isIntentStale(myId)) return;
      console.error("Network error during playback:", e);
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
    if (currentIndex === -1) return;

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
    if (currentIndex === -1) return;

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
          } catch (e) { }

          const ext = currentTrack.originalName?.split('.').pop()?.toLowerCase();
          const url = await invoke<string>("get_stream_url", { fileId: currentTrack.id, bitrate, bufferSeconds, ext });
          if (isIntentStale(myId)) return;
          
          setCurrentTrack(prev => prev ? { ...prev, streamUrl: url } : prev);
          triggerReload();
          setIsPlaying(true);
        } catch (e) {
          if (isIntentStale(myId)) return;
          console.error("Failed to get stream url on resume", e);
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
    setPlayMode(prev => {
      const nextMode = prev === 'normal' ? 'shuffle' : (prev === 'shuffle' ? 'repeat-all' : (prev === 'repeat-all' ? 'repeat-one' : 'normal'));

      if (nextMode === 'shuffle') {
        if (originalQueue.length > 0 && currentTrack) {
          const shuffled = [...originalQueue];
          const trackIndex = shuffled.findIndex(t => t.queueItemId ? (t.queueItemId === currentTrack.queueItemId) : (t.id === currentTrack.id));
          let currentTrackInQueue = currentTrack;
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
        setPlaybackQueue([...originalQueue]);
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
