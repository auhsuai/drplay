import { useEffect } from "react";
import {
  start as keepAwakeStart,
  stop as keepAwakeStop,
} from "tauri-plugin-keepawake-api";
import { set as idbSet } from "../../db/kv";
import type { Track, PlayMode } from "../../types";
import { captureError } from "../../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../../utils/sessionCleanup";
import { AudioController } from "../../lib/AudioController";

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
  setCurrentTrack,
  setIsPlaying,
  setOriginalQueue,
  setPlaybackQueue,
  resetBrokenTracks,
}: PlayerLifecycleDeps): void {
  // Keep system awake
  useEffect(() => {
    if (isPlaying) {
      keepAwakeStart({ display: false, idle: false, sleep: true }).catch(
        (e: unknown) => {
          void logUsePlayer("warn", `keep-awake-failed: ${errMsg(e)}`);
        },
      );
    } else {
      keepAwakeStop().catch((e: unknown) => {
        void logUsePlayer("warn", `keep-awake-release-failed: ${errMsg(e)}`);
      });
    }
  }, [isPlaying]);

  // Persist playMode
  useEffect(() => {
    idbSet(SESSION_CLEANUP_KEYS.playModeKv, playMode).catch((e: unknown) => {
      void logUsePlayer("warn", `playmode-save-fail: ${errMsg(e)}`);
    });
  }, [playMode]);

  // Cleanup on logout
  useEffect(() => {
    const handleStop = () => {
      // B3: release the real audio elements (buffers, src, pending retry)
      // before clearing the store state.
      AudioController.getInstance().release();
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
