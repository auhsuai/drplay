import { useEffect } from "react";
import { get } from "../../db/kv";
import { Track } from "../../App";
import { getValidToken } from "../../utils/apiClient";
import { getPrefetchedStreamUrl } from "../../utils/streamPrefetcher";
import { classifyPlayerError } from "./utils";
import { usePlayerStore } from "../../store/playerStore";
import { AudioController } from "../../lib/AudioController";

export function usePlayerSession(
  setCurrentTrack: (track: Track | null | ((prev: Track | null) => Track | null)) => void,
  setOriginalQueue: (queue: Track[]) => void,
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void,
  setPlayMode: (mode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one' | ((prev: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one') => 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one')) => void,
  setBufferSeconds: (seconds: number) => void,
  triggerReload: () => void
) {
  useEffect(() => {
    const controller = new AbortController();
    const loadSession = async (signal: AbortSignal) => {
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
            } catch (e) {
              console.warn(`[usePlayer] session-restore-stream-fail`, classifyPlayerError(e));
            }
          }
          if (signal.aborted) return;

          const savedQueue = await get('drplay_queue');
          const savedPlayMode = await get('drplay_playmode');
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
              const q = [...savedQueue];
              const idx = q.findIndex(t => t.id === restoredTrack.id);
              let head = idx !== -1 ? q.splice(idx, 1)[0] : { ...restoredTrack, queueItemId: crypto.randomUUID() };
              for (let i = q.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [q[i], q[j]] = [q[j], q[i]];
              }
              q.unshift(head);
              setPlaybackQueue(q);
            } else {
              setPlaybackQueue([...savedQueue]);
            }
          } else {
            setPlaybackQueue([restoredTrack]);
          }
          if (savedPlayMode) setPlayMode(savedPlayMode);
          triggerReload();
        }
      } catch (e: any) {
        if (e.name === 'AbortError') return;
        console.error(`[usePlayer] session-load-failed`, classifyPlayerError(e));
      }
    };
    loadSession(controller.signal);
    return () => controller.abort();
  }, [setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, setBufferSeconds, triggerReload]);

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
      localStorage.setItem("drplay_last_session", JSON.stringify(sessionData));
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
