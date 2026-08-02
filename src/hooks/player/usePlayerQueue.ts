import { useCallback } from "react";
import type { Track, PlayMode } from "../../types";
import { set as idbSet } from "../../db/kv";
import { captureError } from "../../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../../utils/sessionCleanup";
import { classifyPlayerError } from "./utils";

export interface QueueDriveItem {
  isFolder?: boolean;
  trackInfo?: Track;
}

const DRIVE_TAB_NAME = 'My Drive';

const NEXT_MODE: Record<PlayMode, PlayMode> = {
  normal: 'shuffle',
  shuffle: 'repeat-all',
  'repeat-all': 'repeat-one',
  'repeat-one': 'normal',
};

export function ensureQueueItemId(track: Track): Track {
  return track.queueItemId ? track : { ...track, queueItemId: crypto.randomUUID() };
}

export function sameTrack(a: Track, b: Track): boolean {
  if (a.queueItemId && b.queueItemId) return a.queueItemId === b.queueItemId;
  return a.id === b.id;
}

export function shuffleQueueWithCurrent(
  queue: Track[],
  current: Track,
  fallbackHead: Track
): Track[] {
  if (queue.length === 0) return [];
  const shuffled = [...queue];
  const trackIndex = shuffled.findIndex((t) => sameTrack(t, current));
  let currentTrackInQueue = shuffled[0];
  if (trackIndex !== -1) {
    currentTrackInQueue = shuffled[trackIndex];
    shuffled.splice(trackIndex, 1);
  } else {
    currentTrackInQueue = fallbackHead;
  }
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  shuffled.unshift(currentTrackInQueue);
  return shuffled;
}

export function usePlayerQueue(
  currentTrack: Track | null,
  playbackQueue: Track[],
  originalQueue: Track[],
  playMode: PlayMode,
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void,
  setOriginalQueue: (queue: Track[]) => void,
  setPlayMode: (mode: PlayMode | ((prev: PlayMode) => PlayMode)) => void,
  handlePlayTrack: (track: Track, contextQueue?: Track[], isNavigation?: boolean, driveItems?: ReadonlyArray<QueueDriveItem>, activeTab?: string) => void
) {

  const handleNextTrack = useCallback(() => {
    if (!currentTrack || playbackQueue.length === 0) return;

    const currentIndex = playbackQueue.findIndex(item => sameTrack(item, currentTrack));
    if (currentIndex === -1) {
      captureError({ level: 'warn', source: 'usePlayerQueue', message: 'handleNextTrack: current track not found in playbackQueue' });
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

    const currentIndex = playbackQueue.findIndex(item => sameTrack(item, currentTrack));
    if (currentIndex === -1) {
      captureError({ level: 'warn', source: 'usePlayerQueue', message: 'handlePrevTrack: current track not found in playbackQueue' });
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
    const nextMode = NEXT_MODE[playMode];

    if (nextMode === 'shuffle') {
      if (queue.length > 0 && track) {
        setPlaybackQueue(shuffleQueueWithCurrent(queue, track, ensureQueueItemId(track)));
      }
    } else if (playMode === 'shuffle') {
      setPlaybackQueue([...queue]);
    }

    setPlayMode(nextMode);
  }, [playMode, originalQueue, currentTrack, setPlayMode, setPlaybackQueue]);

  const updateQueueContext = useCallback((track: Track, contextQueue?: Track[], driveItems?: ReadonlyArray<QueueDriveItem>, activeTab?: string): Track => {
    let targetTrack = { ...track };
    let newOriginalQueue: Track[] = [];

    if (contextQueue && contextQueue.length > 0) {
      newOriginalQueue = contextQueue.map(t => ensureQueueItemId(t));
    } else if (activeTab === DRIVE_TAB_NAME && driveItems) {
      newOriginalQueue = driveItems.flatMap(item => item.isFolder || !item.trackInfo ? [] : [ensureQueueItemId(item.trackInfo)]);
    }

    if (newOriginalQueue.length > 0) {
      setOriginalQueue(newOriginalQueue);
      idbSet(SESSION_CLEANUP_KEYS.queueKv, newOriginalQueue).catch(e =>
        captureError({ level: 'warn', source: 'usePlayerQueue', message: `queue-save-fail: ${classifyPlayerError(e).message}` })
      );
      if (playMode === 'shuffle') {
        const shuffled = shuffleQueueWithCurrent(newOriginalQueue, track, ensureQueueItemId(track));
        setPlaybackQueue(shuffled);
        targetTrack = shuffled[0];
      } else {
        setPlaybackQueue(newOriginalQueue);
        const trackIndex = newOriginalQueue.findIndex(t => sameTrack(t, track));
        if (trackIndex !== -1) {
          targetTrack = newOriginalQueue[trackIndex];
        } else {
          targetTrack = ensureQueueItemId(track);
        }
      }
    } else {
      targetTrack = ensureQueueItemId(targetTrack);
      setPlaybackQueue([targetTrack]);
      idbSet(SESSION_CLEANUP_KEYS.queueKv, []).catch(e =>
        captureError({ level: 'warn', source: 'usePlayerQueue', message: `queue-clear-fail: ${classifyPlayerError(e).message}` })
      );
    }
    return targetTrack;
  }, [playMode, setOriginalQueue, setPlaybackQueue]);

  return { handleNextTrack, handlePrevTrack, handleTogglePlayMode, updateQueueContext };
}
