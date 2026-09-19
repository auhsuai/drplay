import { useEffect, useRef } from "react";
import {
  start as keepAwakeStart,
  stop as keepAwakeStop,
} from "tauri-plugin-keepawake-api";
import type { Track, PlayMode } from "../../types";
import { captureError } from "../../utils/errorLog";
import { writePlayMode } from "../../utils/playerPersistence";
import { AudioController } from "../../lib/AudioController";
import { usePlayerStore } from "../../store/playerStore";
import { resetAdvanceGuard } from "../../utils/playerError";
import { clearRestoreResume } from "./restoreResume";

export const PLAYER_STOP_EVENT = "player-stop";

export const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const logUsePlayer = (
  level: "warn" | "error",
  message: string,
): Promise<void> => captureError({ level, source: "usePlayer", message });

export interface PlayerLifecycleDeps {
  isPlaying: boolean;
  playMode: PlayMode;
  /** True once usePlayerSession settled its restore read (F7-1 gate). */
  hydrated: boolean;
  setCurrentTrack: (
    track: Track | null | ((prev: Track | null) => Track | null),
  ) => void;
  setIsPlaying: (isPlaying: boolean | ((prev: boolean) => boolean)) => void;
  setOriginalQueue: (queue: Track[]) => void;
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void;
  resetBrokenTracks: () => void;
}

export function usePlayerLifecycle({
  isPlaying,
  playMode,
  hydrated,
  setCurrentTrack,
  setIsPlaying,
  setOriginalQueue,
  setPlaybackQueue,
  resetBrokenTracks,
}: PlayerLifecycleDeps): void {
  // Keep system awake
  const keepAwakeChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // The plugin has no id/handle and does not order its promises, so start
    // and stop are chained here: a stop enqueued after a slow start can never
    // overtake it. The cleanup releases the wake-lock on unmount/toggle.
    const enqueue = (op: () => Promise<unknown>, failMsg: string): void => {
      keepAwakeChainRef.current = keepAwakeChainRef.current.then(op).then(
        () => undefined,
        (e: unknown) => {
          void logUsePlayer("warn", `${failMsg}: ${errMsg(e)}`);
        },
      );
    };
    if (isPlaying) {
      enqueue(
        () => keepAwakeStart({ display: false, idle: false, sleep: true }),
        "keep-awake-failed",
      );
    } else {
      enqueue(() => keepAwakeStop(), "keep-awake-release-failed");
    }
    return () => {
      enqueue(() => keepAwakeStop(), "keep-awake-release-failed");
    };
  }, [isPlaying]);

  // Persist playMode — gated until the session restore has read the persisted
  // value, otherwise the mount-time default write clobbers it (F7-1).
  useEffect(() => {
    if (!hydrated) return;
    writePlayMode(playMode).catch((e: unknown) => {
      void logUsePlayer("warn", `playmode-save-fail: ${errMsg(e)}`);
    });
  }, [playMode, hydrated]);

  // Cleanup on logout
  useEffect(() => {
    const handleStop = () => {
      // F8-4: the storm guard is module-scope state — a fresh session must
      // not inherit the previous session's block/counter (the store is
      // reset below, the guard would otherwise survive the logout).
      resetAdvanceGuard();
      // F7-6: same for the one-shot restore hint — an armed-but-unconsumed
      // position must not leak into the next session and resume a track there.
      clearRestoreResume();
      // B3: release the real audio elements (buffers, src, pending retry)
      // before clearing the store state.
      AudioController.getInstance().release();
      usePlayerStore.getState().setIsDownloading(false);
      setCurrentTrack(null);
      setIsPlaying(false);
      setOriginalQueue([]);
      setPlaybackQueue([]);
      // Task D residual: forget broken-track marks so they don't leak
      // into the next session (auto-advance guard would skip a track that
      // may play fine after a fresh login).
      resetBrokenTracks();
    };
    window.addEventListener(PLAYER_STOP_EVENT, handleStop);
    return () => {
      window.removeEventListener(PLAYER_STOP_EVENT, handleStop);
    };
  }, [
    setCurrentTrack,
    setIsPlaying,
    setOriginalQueue,
    setPlaybackQueue,
    resetBrokenTracks,
  ]);
}
