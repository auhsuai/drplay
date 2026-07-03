import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { get } from "idb-keyval";
import { Track } from "../App"; // Reuse Track type from App.tsx
import { getTrackMetadata } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";

export const usePlayer = (accessToken: string | null) => {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [playMode, setPlayMode] = useState<'normal' | 'shuffle' | 'repeat-all' | 'repeat-one'>('normal');
  const [originalQueue, setOriginalQueue] = useState<Track[]>([]);
  const [playbackQueue, setPlaybackQueue] = useState<Track[]>([]);
  const [bufferSeconds, setBufferSeconds] = useState(1400);

  // Load last session and buffer
  useEffect(() => {
    const loadSession = async () => {
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
          let streamUrl = "";
          const freshToken = await getValidToken();
          if (freshToken) {
            try {
              streamUrl = await invoke<string>("get_stream_url", { 
                fileId: lastSession.track.id, 
                token: freshToken, 
                bitrate: lastSession.track.bitrate, 
                bufferSeconds: storedBuffer || 1400 
              });
            } catch (e) {
              console.warn("Failed to invoke get_stream_url on session restore", e);
            }
          }

          setCurrentTrack({
            ...lastSession.track,
            streamUrl,
            restoreTime: lastSession.time,
            restoreDuration: lastSession.duration
          });
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
    if (!isNavigation) {
      let newOriginalQueue: Track[] = [];
      if (contextQueue && contextQueue.length > 0) {
        newOriginalQueue = contextQueue;
      } else if (activeTab === "My Drive" && driveItems) {
        newOriginalQueue = driveItems.filter(item => !item.isFolder && item.trackInfo).map(item => item.trackInfo!);
      }

      if (newOriginalQueue.length > 0) {
        setOriginalQueue(newOriginalQueue);
        if (playMode === 'shuffle') {
          const shuffled = [...newOriginalQueue];
          const trackIndex = shuffled.findIndex(t => t.id === track.id);
          if (trackIndex !== -1) shuffled.splice(trackIndex, 1);

          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          shuffled.unshift(track);
          setPlaybackQueue(shuffled);
        } else {
          setPlaybackQueue(newOriginalQueue);
        }
      }
    }

    console.log("=== START DOWNLOADING AUDIO ===");
    setCurrentTrack({ ...track, streamUrl: "" });
    setIsPlaying(false);
    setIsDownloading(true);

    try {

      let accurateMetaDuration = undefined;
      const freshToken = await getValidToken();
      if (!freshToken) {
        setIsDownloading(false);
        return;
      }
      
      try {
        const metadata = await getTrackMetadata(track.id, freshToken, track.size, track.originalName);
        if (metadata.duration) {
           accurateMetaDuration = metadata.duration;
        }
      } catch (e) {
        console.warn("Could not get bitrate for buffer calculation", e);
      }

      const streamUrl = await invoke<string>("get_stream_url", { fileId: track.id, token: freshToken, duration: accurateMetaDuration, bufferSeconds });

      setCurrentTrack(prev => {
        if (prev && prev.id === track.id) {
          setIsPlaying(true);
          return { ...prev, streamUrl, restoreDuration: accurateMetaDuration || prev.restoreDuration };
        }
        return prev;
      });
    } catch (e) {
      console.error("Network error during playback:", e);
      alert("An exception occurred! Open Developer Tools (Ctrl+Shift+I) for details.");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleNextTrack = () => {
    if (!currentTrack || playbackQueue.length === 0) return;

    const currentIndex = playbackQueue.findIndex(item => item.id === currentTrack.id);
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

    const currentIndex = playbackQueue.findIndex(item => item.id === currentTrack.id);
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
        setIsDownloading(true);
        try {
          let bitrate = undefined;
          const freshToken = await getValidToken();
          if (!freshToken) {
            setIsDownloading(false);
            return;
          }
          try {
            const metadata = await getTrackMetadata(currentTrack.id, freshToken, currentTrack.size, currentTrack.originalName);
            bitrate = metadata.bitrate;
          } catch (e) { }

          const url = await invoke<string>("get_stream_url", { fileId: currentTrack.id, token: freshToken, bitrate, bufferSeconds });
          setCurrentTrack(prev => prev ? { ...prev, streamUrl: url } : prev);
          setIsPlaying(true);
        } catch (e) {
          console.error("Failed to get stream url on resume", e);
          alert("Could not start playback. Please try another track.");
        } finally {
          setIsDownloading(false);
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
          const trackIndex = shuffled.findIndex(t => t.id === currentTrack.id);
          if (trackIndex !== -1) shuffled.splice(trackIndex, 1);

          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          shuffled.unshift(currentTrack);
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
