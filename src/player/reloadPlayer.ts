/**
 * F5 / Ctrl+R orchestration. A WebView2 reload only refreshes the React page:
 * the Tauri process (and the native mpv engine inside it) keeps running, so
 * the audio continues behind a fresh UI that knows nothing about it. This
 * module owns the single ordered flow that stops the engine BEFORE the page
 * reloads, after persisting the session the reloaded page will restore.
 */
import i18next from "i18next";
import { listen } from "@tauri-apps/api/event";
import { AudioController } from "../lib/AudioController";
import { describeError } from "../lib/mpvProtocol";
import { savePlayerSessionNow } from "../hooks/player/usePlayerSession";
import {
  abortCurrentIntent,
  bumpSessionEpoch,
} from "../hooks/player/playbackIntent";
import { clearRestoreResume } from "../hooks/player/restoreResume";
import { resetAdvanceGuard } from "../utils/playerError";
import { captureError } from "../utils/errorLog";
import { showErrorToast } from "../utils/simpleToast";

const PLAYER_RELOAD_MODULE = "playerReload";

/** Emitted by `src-tauri/src/webview_reload.rs` after it suppressed the
 *  WebView2 browser accelerator for F5/Ctrl+R. The native layer cannot await
 *  the ordered flow, so it hands the request to this one orchestration. */
const NATIVE_RELOAD_REQUEST_EVENT = "player-reload-requested";

/**
 * Bridge the native WebView2 accelerator handler into `requestPlayerReload`.
 * Returns an idempotent unsubscribe. A failure to subscribe is logged, never
 * thrown: the JS keydown path still exists for dev/web builds.
 */
export function listenForNativeReloadRequests(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  listen(NATIVE_RELOAD_REQUEST_EVENT, () => {
    void requestPlayerReload();
  })
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch((e: unknown) => {
      void captureError({
        level: "warn",
        source: PLAYER_RELOAD_MODULE,
        message: `native-reload-listen-failed: ${describeError(e)}`,
      });
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** One reload flow at a time: repeated F5 presses (and chords) must not issue
 *  a second shutdown or a second reload. Cleared only when the flow fails. */
let reloadInProgress = false;

/**
 * Stop playback, persist the session, then reload the page.
 * `reload` is injectable for tests; production always reloads the WebView.
 */
export async function requestPlayerReload(
  reload: () => void = () => {
    window.location.reload();
  },
): Promise<void> {
  if (reloadInProgress) return;
  reloadInProgress = true;
  try {
    // Snapshot BEFORE the engine goes away: the reloaded page restores this
    // track + position, and the engine-clock pairing must still be valid.
    savePlayerSessionNow();
    // Invalidate every in-flight continuation so nothing commits or starts a
    // new play while the engine is shutting down.
    abortCurrentIntent();
    bumpSessionEpoch();
    // Resolves only once the native shutdown completed.
    await AudioController.getInstance().shutdownForReload();
    // The position is re-armed by the restore on the next page load.
    clearRestoreResume();
    resetAdvanceGuard();
    reload();
    // Success: keep the lock closed — the page is about to go away.
  } catch (e: unknown) {
    // The engine may still be playing: do NOT reload and do NOT claim the
    // audio stopped. Reopen the lock so the user can retry.
    reloadInProgress = false;
    void captureError({
      level: "error",
      source: PLAYER_RELOAD_MODULE,
      message: `reload-shutdown-failed: ${describeError(e)}`,
    });
    showErrorToast(
      i18next.t("player.reload_failed", {
        defaultValue:
          "Couldn't stop the player. The page was not refreshed — try again.",
      }),
    );
  }
}

/** Test-only reset of the module-level lock. */
export function __resetPlayerReloadForTests(): void {
  reloadInProgress = false;
}
