import { useEffect } from "react";
import { get } from "../../db/kv";
import { Track } from "../../App";
import { getValidToken } from "../../utils/apiClient";
import { getPrefetchedStreamUrl } from "../../utils/streamPrefetcher";
import { isIntentStale, beginPlaybackIntent } from "./utils";
import { classifyPlayerError } from "./utils";

export function usePlayerSession(
  setCurrentTrack: React.Dispatch<React.SetStateAction<Track | null>>,
  setOriginalQueue: React.Dispatch<React.SetStateAction<Track[]>>,
  setPlaybackQueue: React.Dispatch<React.SetStateAction<Track[]>>,
  setPlayMode: React.Dispatch<React.SetStateAction<'normal' | 'shuffle' | 'repeat-all' | 'repeat-one'>>,
  setBufferSeconds: React.Dispatch<React.SetStateAction<number>>,
  triggerReload: () => void
) {
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
                streamUrl = `/drive-stream/${lastSession.track.id}`;
              }
            } catch (e) {
              console.warn(`[usePlayer] session-restore-stream-fail`, classifyPlayerError(e));
            }
          }
          if (isIntentStale(myId)) return;

          const savedQueue = await get('drplay_queue');
          const savedPlayMode = await get('drplay_playmode');
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
      } catch (e) {
        console.error(`[usePlayer] session-load-failed`, classifyPlayerError(e));
      }
    };
    loadSession();
  }, [setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, setBufferSeconds, triggerReload]);
}
