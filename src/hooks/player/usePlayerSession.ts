import { useEffect } from "react";
import type { Track, PlayMode } from "../../types";
import { getValidToken } from "../../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";
import {
  readPlayMode,
  readQueue,
  readSession,
  writeSession,
} from "../../utils/playerPersistence";
import { classifyPlayerError, isAbortError } from "./utils";
import { PLAYER_STOP_EVENT } from "./usePlayerLifecycle";
import { usePlayerStore } from "../../store/playerStore";
import { AudioController } from "../../lib/AudioController";
import { isForeignTrackEvent } from "../../lib/audioNativeEvents";
import { shuffleQueueWithCurrent } from "./usePlayerQueue";
import { armRestoreResume } from "./restoreResume";

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
  onHydrated: () => void,
) {
  useEffect(() => {
    const controller = new AbortController();
    const isAborted = () => controller.signal.aborted;
    // SC1: teardown (logout/player-stop) clears the store, which defeats the
    // "store still empty" commit guard — an in-flight restore would resurrect
    // the previous account's track/queue. Abort the restore controller on the
    // stop event so every post-await re-check (and the final commit) bails.
    const handleStop = () => {
      controller.abort();
    };
    window.addEventListener(PLAYER_STOP_EVENT, handleStop);
    const loadSession = async (signal: AbortSignal) => {
      try {
        // Scoped-key read with a one-time legacy fallback; corrupt payloads
        // are logged and skipped inside the persistence module.
        const lastSession = await readSession();

        if (lastSession && lastSession.track) {
          if (isAborted()) {
            return;
          }
          let streamUrl = "";
          const freshToken = await getValidToken(false, signal);
          if (isAborted()) return;

          if (freshToken) {
            try {
              streamUrl = getPrefetchedStreamUrl(lastSession.track.id) || "";
              if (!streamUrl) {
                streamUrl = buildStreamUrl(
                  lastSession.track.id,
                  lastSession.track.originalName,
                );
              }
            } catch (e: unknown) {
              void captureError({
                level: "warn",
                source: PLAYER_SESSION_MODULE,
                message: `session-restore-stream-fail: ${classifyPlayerError(e).message}`,
              });
            }
          }
          if (isAborted()) return;

          const savedQueue = await readQueue();
          const savedPlayMode = await readPlayMode();
          if (isAborted()) return;

          // User đã hành động trong lúc restore await (click bài / bắt đầu load):
          // bỏ toàn bộ restore commit để không đè lên intent của user.
          const s = usePlayerStore.getState();
          if (s.currentTrack !== null || s.isDownloading) return;

          const restoredTrack: Track = {
            ...lastSession.track,
            streamUrl,
            ...(lastSession.time !== undefined
              ? { restoreTime: lastSession.time }
              : undefined),
            ...(lastSession.duration !== undefined
              ? { restoreDuration: lastSession.duration }
              : undefined),
          };

          // F7-6/F8-8: the resume position is armed as a ONE-SHOT engine hint
          // (consumed by the first play of this track in PlayerBar's bridge).
          // Track.restoreTime above only feeds SeekBar's initial fill — the
          // track object survives in the queues, so reading the position off
          // it at play time would leak it into every replay/retry.
          if (lastSession.time !== undefined) {
            armRestoreResume(restoredTrack.id, lastSession.time);
          }

          // readQueue decoded the payload and dropped invalid entries
          // (null/number/{} would throw inside shuffleQueueWithCurrent or crash
          // QueuePanel) — the dropped count was logged by the module.
          const validQueue: Track[] = savedQueue ?? [];
          if (validQueue.length > 0) {
            setOriginalQueue(validQueue);
            if (savedPlayMode === "shuffle") {
              setPlaybackQueue(
                shuffleQueueWithCurrent(validQueue, restoredTrack, {
                  ...restoredTrack,
                  queueItemId: crypto.randomUUID(),
                }),
              );
            } else {
              setPlaybackQueue([...validQueue]);
            }
          } else {
            setPlaybackQueue([restoredTrack]);
          }
          // readPlayMode already whitelists the value (unknown versions and
          // junk are logged and skipped inside the persistence module).
          if (savedPlayMode !== undefined) setPlayMode(savedPlayMode);
          setCurrentTrack(restoredTrack);
          triggerReload();
        }
      } catch (e: unknown) {
        if (isAbortError(e)) return;
        void captureError({
          level: "error",
          source: PLAYER_SESSION_MODULE,
          message: `session-load-failed: ${classifyPlayerError(e).message}`,
        });
      } finally {
        // Signal the hydration gate on every settled read path (empty session,
        // corrupt payload, user-intent guard, read error) so playMode persist
        // can resume — F7-1.
        if (!isAborted()) onHydrated();
      }
    };
    void loadSession(controller.signal);
    return () => {
      window.removeEventListener(PLAYER_STOP_EVENT, handleStop);
      controller.abort();
    };
  }, [
    setCurrentTrack,
    setOriginalQueue,
    setPlaybackQueue,
    setPlayMode,
    triggerReload,
    onHydrated,
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
      // SC6: only persist when the engine is actually on the store's track.
      // A switch in flight (store already committed B, engine still on A)
      // would otherwise write {track B, time A}; the next save after the
      // engine begins the new track writes the matching pair.
      if (audio.getCurrentTrackId() !== currentTrack.id) return;
      const time = audio.getCurrentTime();
      const duration = audio.getDuration();

      // Không lưu nếu chưa có dữ liệu hợp lệ
      if (time === 0 && duration === 0) return;

      try {
        writeSession({ track: currentTrack, time, duration });
        lastSaveTime = now;
      } catch (e: unknown) {
        void captureError({
          level: "warn",
          source: PLAYER_SESSION_MODULE,
          message: `session-save-fail: ${classifyPlayerError(e).message}`,
        });
      }
    };

    const handleBeforeUnload = () => {
      saveSession(true);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);

    const audio = AudioController.getInstance();
    // R2.1: the session pairs the store's track with the engine clock, so an
    // event tagged with ANOTHER track means the engine is still on the old
    // track — saving now would persist {track B, time A}. Skip it; the new
    // track's own events save normally. Untagged events keep legacy behavior.
    const isForeign = (payload: { trackId?: string } | undefined) =>
      isForeignTrackEvent(payload, usePlayerStore.getState().currentTrack?.id);
    const unsubTime = audio.on("timeupdate", (payload) => {
      if (isForeign(payload)) return;
      saveSession(false);
    });
    const unsubPause = audio.on("pause", (payload) => {
      if (isForeign(payload)) return;
      saveSession(true);
    });
    const unsubEnded = audio.on("ended", (payload) => {
      if (isForeign(payload)) return;
      saveSession(true);
    });

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handleBeforeUnload);
      unsubTime();
      unsubPause();
      unsubEnded();
    };
  }, []);
}
