import { useEffect } from "react";
import { get } from "../../db/kv";
import type { Track, PlayMode } from "../../types";
import { getValidToken } from "../../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  DRIVE_STREAM_PREFIX,
} from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../../utils/sessionCleanup";
import { classifyPlayerError, isAbortError } from "./utils";
import { usePlayerStore } from "../../store/playerStore";
import { AudioController } from "../../lib/AudioController";
import { shuffleQueueWithCurrent } from "./usePlayerQueue";

const PLAYER_SESSION_MODULE = "usePlayerSession";
const SAVE_THROTTLE_MS = 5000;

export function usePlayerSession(
  setCurrentTrack: (
    track: Track | null | ((prev: Track | null) => Track | null),
  ) => void,
  setOriginalQueue: (queue: Track[]) => void,
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void,
  setPlayMode: (mode: PlayMode | ((prev: PlayMode) => PlayMode)) => void,
  triggerReload: () => void,
) {
  useEffect(() => {
    const controller = new AbortController();
    const loadSession = async (signal: AbortSignal) => {
      try {
        const lastSessionStr = localStorage.getItem(
          SESSION_CLEANUP_KEYS.lastSessionLocalStorage,
        );
        let lastSession;
        if (lastSessionStr) {
          try {
            lastSession = JSON.parse(lastSessionStr);
          } catch (e: unknown) {
            captureError({
              level: "warn",
              source: PLAYER_SESSION_MODULE,
              message: `session-corrupt: ${classifyPlayerError(e).message}`,
            });
            lastSession = await get(SESSION_CLEANUP_KEYS.lastSessionKv);
          }
        } else {
          lastSession = await get(SESSION_CLEANUP_KEYS.lastSessionKv);
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
              streamUrl = getPrefetchedStreamUrl(lastSession.track.id) || "";
              if (!streamUrl) {
                streamUrl = `${DRIVE_STREAM_PREFIX}${lastSession.track.id}`;
              }
            } catch (e: unknown) {
              captureError({
                level: "warn",
                source: PLAYER_SESSION_MODULE,
                message: `session-restore-stream-fail: ${classifyPlayerError(e).message}`,
              });
            }
          }
          if (signal.aborted) return;

          const savedQueue = await get(SESSION_CLEANUP_KEYS.queueKv);
          const savedPlayMode = await get(SESSION_CLEANUP_KEYS.playModeKv);
          if (signal.aborted) return;

          const restoredTrack: Track = {
            ...lastSession.track,
            streamUrl,
            restoreTime: lastSession.time,
            restoreDuration: lastSession.duration,
          };

          if (
            savedQueue &&
            Array.isArray(savedQueue) &&
            savedQueue.length > 0
          ) {
            setOriginalQueue(savedQueue);
            if (savedPlayMode === "shuffle") {
              setPlaybackQueue(
                shuffleQueueWithCurrent(savedQueue, restoredTrack, {
                  ...restoredTrack,
                  queueItemId: crypto.randomUUID(),
                }),
              );
            } else {
              setPlaybackQueue([...savedQueue]);
            }
          } else {
            setPlaybackQueue([restoredTrack]);
          }
          if (
            savedPlayMode === "normal" ||
            savedPlayMode === "shuffle" ||
            savedPlayMode === "repeat-all" ||
            savedPlayMode === "repeat-one"
          ) {
            setPlayMode(savedPlayMode);
          } else if (savedPlayMode) {
            captureError({
              level: "warn",
              source: PLAYER_SESSION_MODULE,
              message: "session-playmode-corrupt",
            });
          }
          setCurrentTrack(restoredTrack);
          triggerReload();
        }
      } catch (e: unknown) {
        if (isAbortError(e)) return;
        captureError({
          level: "error",
          source: PLAYER_SESSION_MODULE,
          message: `session-load-failed: ${classifyPlayerError(e).message}`,
        });
      }
    };
    loadSession(controller.signal);
    return () => controller.abort();
  }, [
    setCurrentTrack,
    setOriginalQueue,
    setPlaybackQueue,
    setPlayMode,
    triggerReload,
  ]);

  // Save session event-driven (Industry Standard)
  useEffect(() => {
    let lastSaveTime = 0;

    const saveSession = (force: boolean = false) => {
      const now = performance.now();
      // Throttle to 5 seconds unless forced (e.g. pause/unload)
      if (!force && now - lastSaveTime < SAVE_THROTTLE_MS) return;

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
        duration,
      };
      try {
        localStorage.setItem(
          SESSION_CLEANUP_KEYS.lastSessionLocalStorage,
          JSON.stringify(sessionData),
        );
        lastSaveTime = now;
      } catch (e: unknown) {
        captureError({
          level: "warn",
          source: PLAYER_SESSION_MODULE,
          message: `session-save-fail: ${classifyPlayerError(e).message}`,
        });
      }
    };

    const handleBeforeUnload = () => saveSession(true);
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);

    const audio = AudioController.getInstance();
    const unsubTime = audio.on("timeupdate", () => saveSession(false));
    const unsubPause = audio.on("pause", () => saveSession(true));
    const unsubEnded = audio.on("ended", () => saveSession(true));

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handleBeforeUnload);
      unsubTime();
      unsubPause();
      unsubEnded();
    };
  }, []);
}
