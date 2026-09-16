import { memo, useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { List } from "lucide-react";
import { AudioController } from "../../lib/AudioController";
import { usePlayerStore } from "../../store/playerStore";
import type { PlayerBarProps } from "./types";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { TrackInfo } from "./TrackInfo";
import { TransportControls } from "./TransportControls";
import { SeekBar } from "../components/SeekBar";
import { VolumeSlider } from "./VolumeSlider";
import { ErrorToast } from "./ErrorToast";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";
import {
  guardAllowsAutoAdvance,
  noteFormatError,
  resetAdvanceGuard,
  retryCurrentTrack,
} from "../../utils/playerError";

function PlayerBarImpl({
  currentTrack,
  isPlaying,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  isDownloading,
  loadNonce,
  playMode,
  onTogglePlayMode,
  onExpandNowPlaying,
  isQueueOpen,
  onToggleQueue,
}: PlayerBarProps) {
  const { t } = useTranslation();
  const audio = AudioController.getInstance();

  // Local UI state (không gây ảnh hưởng global). Seek/volume/favorite state
  // is owned by SeekBar/VolumeSlider/TrackInfo — this composition layer only
  // keeps transport-level state (PLAN v2 — render-critical isolation).
  const [isBuffering, setIsBuffering] = useState(false);

  // The error surface is shared with the full-screen NowPlaying controls
  // (P2-12-6): PlayerBar publishes/reads it through the store, the storm
  // guard + manual retry live in utils/playerError.
  const errorInfo = usePlayerStore((state) => state.errorInfo);
  const setErrorInfo = usePlayerStore((state) => state.setErrorInfo);

  // Fix I: manual transport actions (buttons + keyboard) reset the guard
  // before delegating to the App-level handlers. Auto-advance (the `ended`
  // subscription) calls the RAW onNextTrack — it is the behavior being
  // guarded and must never reset the counter. Retrying is a manual action
  // too: utils/playerError.retryCurrentTrack resets the guard it shares.
  const handleManualNext = useCallback(() => {
    resetAdvanceGuard();
    onNextTrack(false);
  }, [onNextTrack]);

  const handleManualPrev = useCallback(() => {
    resetAdvanceGuard();
    onPrevTrack();
  }, [onPrevTrack]);

  const handleManualTogglePlay = useCallback(() => {
    resetAdvanceGuard();
    onTogglePlay();
  }, [onTogglePlay]);

  // Subscribe to AudioController Events (transport-relevant only — seek /
  // buffer-bar subscriptions live in SeekBar next to the DOM they own).
  useEffect(() => {
    const unsubBuf = audio.on("buffering", ({ isBuffering }) => {
      setIsBuffering(isBuffering);
    });
    const unsubErr = audio.on("error", (err) => {
      // Task D: an unrecoverable playback failure (format_error — broken
      // format/decode or retry give-up) marks the current track broken so the
      // auto-advance guard in usePlayerQueue skips it instead of looping it
      // forever under repeat-all. AudioController emits `error` BEFORE
      // `ended`, so the mark lands while the store still points at the failed
      // track. Read the store rather than the prop: this subscription is
      // memoized and must not close over a stale track.
      if (err.code === "format_error") {
        const { currentTrack: current, markTrackBroken } =
          usePlayerStore.getState();
        if (current) markTrackBroken(current.id);

        // Fix I: count the failure against the shared storm window
        // (utils/playerError). A tripped/blocked guard shows the clear storm
        // banner instead of the per-track error, which the next track change
        // would clear before it can be read.
        if (noteFormatError(Date.now())) {
          usePlayerStore.getState().setErrorInfo({
            code: "advance_stopped",
            message: "Drive is overloaded or locked — auto-playback paused.",
          });
          return;
        }
      }
      usePlayerStore.getState().setErrorInfo(err);
    });
    // A `play` event is the native "playback actually resumed" signal — it
    // fires after a successful auto-retry, so the stale error banner (and its
    // RefreshCw button) must not outlive the recovery. Fix I: a successful
    // play also proves the storm is over — reset the counter and unblock.
    const unsubPlay = audio.on("play", () => {
      resetAdvanceGuard();
      usePlayerStore.getState().setErrorInfo(null);
    });
    const unsubEnded = audio.on("ended", () => {
      // Fix I: while a format_error storm is blocked, an `ended` must NOT
      // auto-advance — the next track would only fail again. Stop playback
      // instead; the storm banner (set by the error handler) stays visible
      // because the current track is no longer replaced. A natural
      // track-completion `ended` (no format_error in between) never trips the
      // guard — the counter only grows from the error subscription.
      if (!guardAllowsAutoAdvance(Date.now())) {
        usePlayerStore.getState().setIsPlaying(false);
        return;
      }
      // Repeat-one parity: the mpv engine has no loop property and
      // resolveNextTrack never returns the current track for this mode, so the
      // ended handler must replay the same track itself (playbackFinished is
      // true after EOF, so playTrack falls through to a loadfile replace from
      // 0 instead of the same-track no-op). Read the store, not the props: the
      // subscription is memoized and must not close over a stale track/mode.
      const { playMode, currentTrack: cur } = usePlayerStore.getState();
      if (playMode === "repeat-one" && cur) {
        void audio.playTrack(cur, 0);
        return;
      }
      onNextTrack(true);
    });

    return () => {
      unsubBuf();
      unsubErr();
      unsubPlay();
      unsubEnded();
    };
  }, [onNextTrack, audio]);

  // DEV-only debug trigger (Ctrl+Shift+D panel): renders the SAME error banner
  // as a real AudioController error via setErrorInfo only — it deliberately
  // does NOT touch the storm guard (no markTrackBroken, no noteFormatError)
  // so the debug channel can never fake a storm or mark tracks broken. The
  // helper no-ops in production builds.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.PLAYER_ERROR, ({ code, message }) => {
      setErrorInfo({ code, message });
    });
  }, [setErrorInfo]);

  // Handle Keyboard Shortcuts (transport keys; seek/volume keys live in
  // SeekBar/VolumeSlider). Fix I: wrapped handlers so keyboard next/prev/play
  // also reset the storm guard (they are manual user actions).
  useKeyboardShortcuts({
    onNextTrack: handleManualNext,
    onPrevTrack: handleManualPrev,
    onTogglePlay: handleManualTogglePlay,
    onTogglePlayMode,
    onToggleQueue,
  });

  // Handle Play/Pause from Props (Syncing)
  useEffect(() => {
    if (!currentTrack) return;
    if (isPlaying) {
      void audio.playTrack(currentTrack, currentTrack.restoreTime);
    } else {
      audio.pause();
    }
  }, [isPlaying, currentTrack, loadNonce, audio]);

  return (
    <div className="h-20 bg-white dark:bg-[#202124] flex items-center justify-between px-2 sm:px-4 shrink-0 z-10 transition-colors duration-300 relative">
      {/* Left: Track Info */}
      <TrackInfo
        currentTrack={currentTrack}
        onExpandNowPlaying={onExpandNowPlaying}
      />

      {/* Center: Controls */}
      <div className="flex flex-col items-center justify-center flex-1 max-w-[722px] min-w-[200px]">
        <TransportControls
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          isBuffering={isBuffering}
          isDownloading={isDownloading ?? false}
          hasError={errorInfo !== null}
          onRetry={retryCurrentTrack}
          playMode={playMode}
          onTogglePlay={handleManualTogglePlay}
          onPrevTrack={handleManualPrev}
          onNextTrack={handleManualNext}
          onTogglePlayMode={onTogglePlayMode}
        />
        <SeekBar currentTrack={currentTrack} audio={audio} variant="top" />
      </div>

      {/* Right: Volume Controls (queue button leads the volume icon) */}
      <VolumeSlider
        audio={audio}
        leading={
          <button
            type="button"
            onClick={onToggleQueue}
            aria-label={t("queue.open")}
            title={t("queue.open")}
            aria-expanded={isQueueOpen}
            className={`p-2 rounded-full transition-all active:scale-[0.92] shrink-0 ${
              isQueueOpen
                ? "text-brand-text bg-brand-primary/10"
                : "text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"
            }`}
          >
            <List className="w-6 h-6" />
          </button>
        }
      />

      {/* Error Toast */}
      <ErrorToast errorInfo={errorInfo} />
    </div>
  );
}

export const PlayerBar = memo(PlayerBarImpl, (prevProps, nextProps) => {
  return (
    prevProps.currentTrack?.id === nextProps.currentTrack?.id &&
    prevProps.isPlaying === nextProps.isPlaying &&
    prevProps.playMode === nextProps.playMode &&
    prevProps.isDownloading === nextProps.isDownloading &&
    prevProps.loadNonce === nextProps.loadNonce &&
    // The queue drawer lives in App/AppShell now; without this the memoized
    // bar would keep the stale button highlight + aria-expanded.
    prevProps.isQueueOpen === nextProps.isQueueOpen
  );
});
