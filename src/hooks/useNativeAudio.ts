import { useEffect } from "react";
import { nativeAudioEngine } from "../lib/nativeAudioBridge";
import { IS_MOBILE } from "../utils/platform";
import { captureError } from "../utils/errorLog";

/**
 * Mobile-only: initializes the native (ExoPlayer) audio engine once when the
 * player mounts. The engine itself is a module singleton — this hook only
 * owns the lifecycle: plugin initialize() (which also triggers the Android
 * 13+ notification permission prompt) + failure logging.
 *
 * Desktop: inert — returns null and never touches the native engine.
 */
export function useNativeAudio() {
  useEffect(() => {
    if (!IS_MOBILE) return;
    void nativeAudioEngine.initOnce().catch((e: unknown) => {
      void captureError({
        level: "warn",
        source: "useNativeAudio",
        message: `native-audio-init-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
  }, []);

  return IS_MOBILE ? nativeAudioEngine : null;
}
