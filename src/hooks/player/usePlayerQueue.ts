import { useCallback } from "react";
import { Track } from "../../App";
import { set as idbSet } from "../../db/kv";
import { classifyPlayerError } from "./utils";

export function usePlayerQueue(
  currentTrack: Track | null,
  playbackQueue: Track[],
  originalQueue: Track[],
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one',
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void,
  setOriginalQueue: (queue: Track[]) => void,
  setPlayMode: (mode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one' | ((prev: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one') => 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one')) => void,
  handlePlayTrack: (track: Track, contextQueue?: Track[], isNavigation?: boolean, driveItems?: any[], activeTab?: string) => void
) {

  const handleNextTrack = useCallback(() => {
    if (!currentTrack || playbackQueue.length === 0) return;

    const currentIndex = playbackQueue.findIndex(item => item.queueItemId ? (item.queueItemId === currentTrack.queueItemId) : (item.id === currentTrack.id));
    if (currentIndex === -1) {
      console.warn(`[usePlayerQueue] handleNextTrack: current track not found in playbackQueue`, { currentTrackId: currentTrack?.id });
      return;
    }

    if (currentIndex < playbackQueue.length - 1) {
      handlePlayTrack(playbackQueue[currentIndex + 1], undefined, true);
    } else {
      if (playMode === 'repeat-all' || playMode === 'shuffle') {
        handlePlayTrack(playbackQueue[0], undefined, true);
      }
    }
  }, [currentTrack, playbackQueue, playMode, handlePlayTrack]);

  const handlePrevTrack = useCallback(() => {
    if (!currentTrack || playbackQueue.length === 0) return;

    const currentIndex = playbackQueue.findIndex(item => item.queueItemId ? (item.queueItemId === currentTrack.queueItemId) : (item.id === currentTrack.id));
    if (currentIndex === -1) {
      console.warn(`[usePlayerQueue] handlePrevTrack: current track not found in playbackQueue`, { currentTrackId: currentTrack?.id });
      return;
    }

    if (currentIndex > 0) {
      handlePlayTrack(playbackQueue[currentIndex - 1], undefined, true);
    } else {
      if (playMode === 'repeat-all' || playMode === 'shuffle') {
        handlePlayTrack(playbackQueue[playbackQueue.length - 1], undefined, true);
      }
    }
  }, [currentTrack, playbackQueue, playMode, handlePlayTrack]);

  const handleTogglePlayMode = useCallback(() => {
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
  }, [originalQueue, currentTrack, setPlayMode, setPlaybackQueue]);

  const updateQueueContext = useCallback((track: Track, contextQueue?: Track[], driveItems?: any[], activeTab?: string): Track => {
    let targetTrack = { ...track };
    let newOriginalQueue: Track[] = [];

    if (contextQueue && contextQueue.length > 0) {
      newOriginalQueue = contextQueue.map(t => ({...t, queueItemId: t.queueItemId || crypto.randomUUID()}));
    } else if (activeTab === "My Drive" && driveItems) {
      newOriginalQueue = driveItems.filter(item => !item.isFolder && item.trackInfo).map(item => ({...item.trackInfo!, queueItemId: item.trackInfo!.queueItemId || crypto.randomUUID()}));
    }

    if (newOriginalQueue.length > 0) {
      setOriginalQueue(newOriginalQueue);
      idbSet('drplay_queue', newOriginalQueue).catch(e =>
        console.warn(`[usePlayerQueue] queue-save-fail`, classifyPlayerError(e))
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
        console.warn(`[usePlayerQueue] queue-clear-fail`, classifyPlayerError(e))
      );
    }
    return targetTrack;
  }, [playMode, setOriginalQueue, setPlaybackQueue]);

  return { handleNextTrack, handlePrevTrack, handleTogglePlayMode, updateQueueContext };
}
