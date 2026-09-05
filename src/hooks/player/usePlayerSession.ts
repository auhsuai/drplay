import { useEffect } from "react";
import { get, set as idbSet } from "../../db/kv";
import type { Track, PlayMode } from "../../types";
import { getValidToken } from "../../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";
import { IS_MOBILE } from "../../utils/platform";
import { SESSION_CLEANUP_KEYS } from "../../utils/sessionCleanup";
import { classifyPlayerError, isAbortError } from "./utils";
import { usePlayerStore } from "../../store/playerStore";
import { getPlaybackEngine } from "../../lib/nativeAudioBridge";
import { shuffleQueueWithCurrent } from "./usePlayerQueue";

const PLAYER_SESSION_MODULE = "usePlayerSession";
const SAVE_THROTTLE_MS = 5000;
const SESSION_RESTORE_SUPERSEDED_MESSAGE = "session-restore-superseded-by-user";

// Shape of the persisted session payload (localStorage + kv). Optional fields
// mirror the defensive `if (lastSession && lastSession.track)` guards below;
// the real payload always carries them, but a corrupt/older session must not
// crash the restore.
interface StoredSession {
  track?: Track;
  time?: number;
  duration?: number;
}

export function usePlayerSession(
  setCurrentTrack: (
    track: Track | null | ((prev: Track | null) => Track | null),
  ) => void,
  setOriginalQueue: (queue: Track[]) => void,
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void,
  setPlayMode: (mode: PlayMode | ((prev: PlayMode) => PlayMode)) => void,
  triggerReload: () => void,
  hasUserInteracted?: () => boolean,
) {
  useEffect(() => {
    const controller = new AbortController();
    const isAborted = () => controller.signal.aborted;
    const loadSession = async (signal: AbortSignal) => {
      // user-wins contract: nếu user tương tác trong cửa sổ restore (giữa các
      // await), phiên lưu cũ phải nhường đường toàn phần — không ghi đè
      // queue/track user vừa chọn. Warn đúng 1 lần mỗi run (mirror style
      // session-corrupt).
      let supersededLogged = false;
      const userHasActed = () => {
        const acted = hasUserInteracted?.() === true;
        if (acted && !supersededLogged) {
          supersededLogged = true;
          void captureError({
            level: "warn",
            source: PLAYER_SESSION_MODULE,
            message: SESSION_RESTORE_SUPERSEDED_MESSAGE,
          });
        }
        return acted;
      };
      try {
        const lastSessionStr = localStorage.getItem(
          SESSION_CLEANUP_KEYS.lastSessionLocalStorage,
        );
        let lastSession: StoredSession | undefined;
        if (lastSessionStr) {
          try {
            lastSession = JSON.parse(lastSessionStr) as StoredSession;
          } catch (e: unknown) {
            void captureError({
              level: "warn",
              source: PLAYER_SESSION_MODULE,
              message: `session-corrupt: ${classifyPlayerError(e).message}`,
            });
            lastSession = await get<StoredSession>(
              SESSION_CLEANUP_KEYS.lastSessionKv,
            );
          }
        } else {
          lastSession = await get<StoredSession>(
            SESSION_CLEANUP_KEYS.lastSessionKv,
          );
        }

        if (lastSession && lastSession.track) {
          if (isAborted() || userHasActed()) {
            return;
          }
          let streamUrl = "";
          const freshToken = await getValidToken(false, signal);
          if (isAborted() || userHasActed()) return;

          // Mobile (GATE branch B): prefetch is desktop-only, so the fallback
          // below would always embed a /drive-stream URL the SW proxy can
          // never serve on Android — restored track carries streamUrl="" and
          // usePlayer resolves it lazily on play. Desktop path unchanged.
          if (freshToken && !IS_MOBILE) {
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
          if (isAborted() || userHasActed()) return;

          const savedQueue = await get<Track[]>(SESSION_CLEANUP_KEYS.queueKv);
          // unknown (the default get<T>): a corrupt/older persisted value must
          // still hit the corrupt-log branch below instead of crashing.
          const savedPlayMode = await get(SESSION_CLEANUP_KEYS.playModeKv);
          if (isAborted() || userHasActed()) return;

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
            void captureError({
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
        void captureError({
          level: "error",
          source: PLAYER_SESSION_MODULE,
          message: `session-load-failed: ${classifyPlayerError(e).message}`,
        });
      }
    };
    void loadSession(controller.signal);
    return () => {
      controller.abort();
    };
  }, [
    setCurrentTrack,
    setOriginalQueue,
    setPlaybackQueue,
    setPlayMode,
    triggerReload,
    hasUserInteracted,
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

      // Desktop: HTMLAudio element. Android: native ExoPlayer engine — both
      // expose getCurrentTime/getDuration, so session persistence is shared.
      const audio = getPlaybackEngine();
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
        // Dual-write: the load path falls back to this kv copy when
        // localStorage is empty or corrupt, so the key must be written here.
        idbSet(SESSION_CLEANUP_KEYS.lastSessionKv, sessionData).catch(
          (e: unknown) => {
            void captureError({
              level: "warn",
              source: PLAYER_SESSION_MODULE,
              message: `session-kv-save-fail: ${classifyPlayerError(e).message}`,
            });
          },
        );
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

    const audio = getPlaybackEngine();
    const unsubTime = audio.on("timeupdate", () => {
      saveSession(false);
    });
    const unsubPause = audio.on("pause", () => {
      saveSession(true);
    });
    const unsubEnded = audio.on("ended", () => {
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
