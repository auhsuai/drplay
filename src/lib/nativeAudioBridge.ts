/**
 * Native (ExoPlayer/Media3) audio engine for Android — the PRIMARY playback
 * path on mobile (GATE branch B: the SW proxy is dead on Tauri Android,
 * wry#1710). Desktop playback is 100% untouched: this module is inert unless
 * IS_MOBILE, and `getPlaybackEngine()` returns the desktop AudioController
 * singleton on every non-mobile platform.
 *
 * The engine mirrors AudioController's public surface (on/playTrack/pause/
 * seek/getCurrentTime/getDuration/getBuffered/release)
 * so the whole desktop player UI layer (PlayerBar storm guard, SeekBar,
 * auto-advance, session save) works against it unchanged — only the transport
 * differs: tauri-plugin-native-audio commands instead of HTMLAudioElement.
 *
 * This module is the stable import surface for the whole app: the
 * implementation lives in nativeAudioTypes.ts (shared contract),
 * nativeAudioInvoke.ts (bounded-invoke plumbing) and nativeAudioEngine.ts
 * (the ExoPlayer engine class) — re-exported here so consumer import paths
 * never change.
 */

import { IS_MOBILE } from "../utils/platform";
import { AudioController } from "./AudioController";
import { nativeAudioEngine } from "./nativeAudioEngine";
import type { PlaybackEngine } from "./nativeAudioTypes";

export type {
  NativeAudioStatus,
  NativeAudioState,
  PlaybackEngineEventMap,
  PlaybackEngineEventHandler,
  PlaybackEngine,
} from "./nativeAudioTypes";
export {
  NativeInvokeTimeoutError,
  buildDriveStreamUrl,
} from "./nativeAudioInvoke";
export { NativeAudioEngine, nativeAudioEngine } from "./nativeAudioEngine";

/**
 * Single engine selector for the whole app: desktop keeps the HTMLAudio
 * controller, mobile gets the native ExoPlayer engine. Both classes declare
 * `implements PlaybackEngine`, so their surface can never drift silently —
 * a signature change on either side fails tsc at compile time.
 */
export function getPlaybackEngine(): PlaybackEngine {
  return IS_MOBILE ? nativeAudioEngine : AudioController.getInstance();
}
