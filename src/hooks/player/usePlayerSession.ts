import { useEffect } from "react";
import { get } from "../../db/kv";
import type { Track, PlayMode } from "../../types";
import { getValidToken } from "../../utils/apiClient";
import { getPrefetchedStreamUrl } from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";
import { classifyPlayerError } from "./utils";
import { usePlayerStore } from "../../store/playerStore";
import { AudioController } from "../../lib/AudioController";
import { shuffleQueueWithCurrent } from "./usePlayerQueue";

// Duck-typed name extraction: DOMException is NOT instanceof Error in some
// environments (jsdom), yet carries a reliable .name ('AbortError' for
// deliberate cancels). Same rationale as useTauriEvents.ts / useMenuDownload.ts.
function errName(err: unknown): string {
  return err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string'
    ? (err as { name: string }).name
    : '';
}

const PLAYER_SESSION_MODULE = 'usePlayerSession';
const SESSION_STORAGE_KEY = 'drplay_last_session';
const QUEUE_STORAGE_KEY = 'drplay_queue';
const PLAYMODE_STORAGE_KEY = 'drplay_playmode';

export function usePlayerSession(
  setCurrentTrack: (track: Track | null | ((prev: Track | null) => Track | null)) => void,
  setOriginalQueue: (queue: Track[]) => void,
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void,
  setPlayMode: (mode: PlayMode | ((prev: PlayMode) => PlayMode)) => void,
  triggerReload: () => void
) {
  useEffect(() => {
    const controller = new AbortController();
    const loadSession = async (signal: AbortSignal) => {
      try {
        const lastSessionStr = localStorage.getItem(SESSION_STORAGE_KEY);
        let lastSession;
        if (lastSessionStr) {
          try {
            lastSession = JSON.parse(lastSessionStr);
          } catch (e: unknown) {
            captureError({ level: 'warn', source: PLAYER_SESSION_MODULE, message: `session-corrupt: ${classifyPlayerError(e).message}` });
            lastSession = await get(SESSION_STORAGE_KEY);
          }
        } else {
          lastSession = await get(SESSION_STORAGE_KEY);
        }

        if (lastSession && lastSession.track) {
          if (signal.aborted) {
            return;
          }
          let streamUrl = "";
          const freshToken = await getValidToken(false, signal);
          if (signal.aborted) return;
          
          if (freshToken) {
            try {
              streamUrl = getPrefetchedStreamUrl(lastSession.track.id) || '';
              if (!streamUrl) {
                streamUrl = `/drive-stream/${lastSession.track.id}`;
              }
            } catch (e: unknown) {
              captureError({ level: 'warn', source: PLAYER_SESSION_MODULE, message: `session-restore-stream-fail: ${classifyPlayerError(e).message}` });
            }
          }
          if (signal.aborted) return;

          const savedQueue = await get(QUEUE_STORAGE_KEY);
          const savedPlayMode = await get(PLAYMODE_STORAGE_KEY);
          if (signal.aborted) return;

          const restoredTrack: Track = {
            ...lastSession.track,
            streamUrl,
            restoreTime: lastSession.time,
            restoreDuration: lastSession.duration,
          };
          setCurrentTrack(restoredTrack);

          if (savedQueue && Array.isArray(savedQueue) && savedQueue.length > 0) {
            setOriginalQueue(savedQueue);
            if (savedPlayMode === 'shuffle') {
              setPlaybackQueue(shuffleQueueWithCurrent(savedQueue, restoredTrack, { ...restoredTrack, queueItemId: crypto.randomUUID() }));
            } else {
              setPlaybackQueue([...savedQueue]);
            }
          } else {
            setPlaybackQueue([restoredTrack]);
          }
          if (savedPlayMode) setPlayMode(savedPlayMode as PlayMode);
          triggerReload();
        }
      } catch (e: unknown) {
        if (errName(e) === 'AbortError') return;
        captureError({ level: 'error', source: PLAYER_SESSION_MODULE, message: `session-load-failed: ${classifyPlayerError(e).message}` });
      }
    };
    loadSession(controller.signal);
    return () => controller.abort();
  }, [setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, triggerReload]);

  // Save session event-driven (Industry Standard)
  useEffect(() => {
    let lastSaveTime = 0;

    const saveSession = (force: boolean = false) => {
      const now = performance.now();
      // Throttle to 5 seconds unless forced (e.g. pause/unload)
      if (!force && now - lastSaveTime < 5000) return;

      const { currentTrack } = usePlayerStore.getState();
      if (!currentTrack) return;
      
      const audio = AudioController.getInstance();
      const time = audio.getCurrentTime();
      const duration = audio.getDuration();
      
      // Không lưu nếu chưa có dữ liệu hợp lệ
      if (time === 0 && duration === 0) return;
      
      const sessionData = {
        track: currentTrack,
        time,
        duration
      };
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionData));
      lastSaveTime = now;
    };

    const handleBeforeUnload = () => saveSession(true);
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    const audio = AudioController.getInstance();
    const unsubTime = audio.on('timeupdate', () => saveSession(false));
    const unsubPause = audio.on('pause', () => saveSession(true));
    const unsubEnded = audio.on('ended', () => saveSession(true));

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      unsubTime();
      unsubPause();
      unsubEnded();
    };
  }, []);
}
