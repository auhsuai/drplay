import { memo, useCallback, useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getPlaybackEngine } from "../../lib/nativeAudioBridge";
import { usePlayerStore } from "../../store/playerStore";
import { seekRelative, SEEK_STEP_SECONDS } from "../../hooks/player/utils";
import { IS_MOBILE } from "../../utils/platform";
import type { PlayerBarProps } from "./types";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { TrackInfo } from "./TrackInfo";
import { TransportControls } from "./TransportControls";
import { useFavoriteForTrack } from "./useFavoriteForTrack";
import { MoreMenu } from "../components/MoreMenu";
import { SeekBar } from "../components/SeekBar";
import { VolumeSlider } from "./VolumeSlider";
import { ErrorToast } from "./ErrorToast";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

// Fix I — auto-advance storm guard. When EVERY track fails with format_error
// (unrecoverable decode / SRC_NOT_SUPPORTED — e.g. Drive locked or quota hit),
// AudioController emits error → ended → auto-next per track, silently burning
// through the whole queue (the per-track toast is cleared by the next track
// change before it can be read). After STORM_ERRORS format_errors inside
// STORM_WINDOW_MS the guard stops auto-advance, pauses playback and shows a
// clear message instead. A blocked guard re-arms after STORM_COOLDOWN_MS
// without new errors; any successful play or manual transport action resets
// it immediately.
export const STORM_ERRORS = 3;
export const STORM_WINDOW_MS = 15_000;
export const STORM_COOLDOWN_MS = 30_000;

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
}: PlayerBarProps) {
  const { t } = useTranslation();
  // Favorite state for the mobile MoreMenu (row reorder 2026-08-17): TrackInfo
  // keeps its own instance for the desktop heart; this one feeds the
  // PlayerBar-level menu. Both share the same check/toggle logic via the hook.
  const { isLiked, toggleFavorite } = useFavoriteForTrack(currentTrack);
  // Desktop: HTMLAudioElement controller. Android (GATE branch B): the native
  // ExoPlayer engine — same event surface, so the storm guard, auto-advance,
  // seek bar and session save below work unchanged on both.
  const audio = getPlaybackEngine();

  // Local UI state (không gây ảnh hưởng global). Seek/volume/favorite state
  // is owned by SeekBar/VolumeSlider/TrackInfo — this composition layer only
  // keeps transport-level state (PLAN v2 — render-critical isolation).
  const [isBuffering, setIsBuffering] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{
    message: string;
    code: string;
  } | null>(null);

  // Fix I — storm guard state. Refs (not state): the counter must be read and
  // written from AudioController event callbacks without re-rendering the
  // memoized PlayerBar on every failed track. The counter is deliberately NOT
  // reset when currentTrack changes — the auto-advance path itself changes
  // the track every cycle, so a track-change reset would re-arm the guard on
  // every failed skip and the storm would never trip.
  const formatErrorCountRef = useRef(0);
  const stormWindowStartRef = useRef(0);
  const stormBlockedAtRef = useRef<number | null>(null);

  // Fix I: a user-initiated transport action is a fresh start — the user is
  // aware and in control, so the guard must not hold back the next
  // auto-advance. Also used to re-arm a guard whose cooldown expired.
  const resetAdvanceGuard = useCallback(() => {
    formatErrorCountRef.current = 0;
    stormWindowStartRef.current = 0;
    stormBlockedAtRef.current = null;
  }, []);

  // Fix I: manual transport actions (buttons + keyboard) reset the guard
  // before delegating to the App-level handlers. Auto-advance (the `ended`
  // subscription) calls the RAW onNextTrack — it is the behavior being
  // guarded and must never reset the counter.
  const handleManualNext = useCallback(() => {
    resetAdvanceGuard();
    onNextTrack(false);
  }, [onNextTrack, resetAdvanceGuard]);

  const handleManualPrev = useCallback(() => {
    resetAdvanceGuard();
    onPrevTrack();
  }, [onPrevTrack, resetAdvanceGuard]);

  const handleManualTogglePlay = useCallback(() => {
    resetAdvanceGuard();
    onTogglePlay();
  }, [onTogglePlay, resetAdvanceGuard]);

  // Task 5 mobile: ±5s seek buttons. Same shared helper as the ArrowLeft/Right
  // keyboard seek (clamp 0..duration, no-op while duration is unloaded) — NOT
  // a transport action, so the storm guard is deliberately not reset (same as
  // the arrow keys).
  const handleRewind5 = useCallback(() => {
    seekRelative(audio, -SEEK_STEP_SECONDS);
  }, [audio]);

  const handleForward5 = useCallback(() => {
    seekRelative(audio, SEEK_STEP_SECONDS);
  }, [audio]);

  // Replaces the old retryPlayback: retrying from the storm message is a
  // manual action too, so the guard must reset with it.
  const handleManualRetry = useCallback(() => {
    resetAdvanceGuard();
    if (currentTrack) {
      void audio.playTrack(currentTrack, currentTrack.restoreTime);
    }
  }, [currentTrack, audio, resetAdvanceGuard]);

  // Reset transient track state when the track changes. Done during render
  // (React "adjusting state during render" pattern) so no setState happens
  // synchronously inside an effect (react-hooks/set-state-in-effect).
  const prevTrackIdRef = useRef<string | undefined>(undefined);
  if (currentTrack?.id !== prevTrackIdRef.current) {
    prevTrackIdRef.current = currentTrack?.id;
    if (errorInfo) setErrorInfo(null);
  }

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

        // Fix I: count the failure against the storm window. Sliding window:
        // an error landing more than STORM_WINDOW_MS after the window start
        // opens a new window (so 3 errors spread over a long session never
        // trip). A blocked guard absorbs further errors (extending its
        // cooldown) and keeps the storm banner up; once STORM_COOLDOWN_MS
        // passes without a new error the guard re-arms from scratch.
        const now = Date.now();
        if (stormBlockedAtRef.current !== null) {
          if (now - stormBlockedAtRef.current <= STORM_COOLDOWN_MS) {
            setErrorInfo({
              code: "advance_stopped",
              message: "Drive is overloaded or locked — auto-playback paused.",
            });
            return;
          }
          resetAdvanceGuard();
        }
        if (now - stormWindowStartRef.current > STORM_WINDOW_MS) {
          formatErrorCountRef.current = 1;
          stormWindowStartRef.current = now;
        } else {
          formatErrorCountRef.current += 1;
        }
        if (formatErrorCountRef.current >= STORM_ERRORS) {
          stormBlockedAtRef.current = Date.now();
          setErrorInfo({
            code: "advance_stopped",
            message: "Drive is overloaded or locked — auto-playback paused.",
          });
          return;
        }
      }
      setErrorInfo(err);
    });
    // A `play` event is the native "playback actually resumed" signal — it
    // fires after a successful auto-retry, so the stale error banner (and its
    // RefreshCw button) must not outlive the recovery. Fix I: a successful
    // play also proves the storm is over — reset the counter and unblock.
    const unsubPlay = audio.on("play", () => {
      resetAdvanceGuard();
      setErrorInfo(null);
    });
    const unsubEnded = audio.on("ended", () => {
      // Fix I: while a format_error storm is armed, an `ended` must NOT
      // auto-advance — the next track would only fail again. Stop playback
      // instead; the storm banner (set by the error handler) stays visible
      // because the current track is no longer replaced. A natural
      // track-completion `ended` (no format_error in between) never trips the
      // guard — the counter only grows from the error subscription.
      if (stormBlockedAtRef.current !== null) {
        if (Date.now() - stormBlockedAtRef.current <= STORM_COOLDOWN_MS) {
          usePlayerStore.getState().setIsPlaying(false);
          return;
        }
        resetAdvanceGuard();
      }
      onNextTrack(true);
    });

    return () => {
      unsubBuf();
      unsubErr();
      unsubPlay();
      unsubEnded();
    };
  }, [onNextTrack, audio, resetAdvanceGuard]);

  // DEV-only debug trigger (Ctrl+Shift+D panel): renders the SAME error banner
  // as a real AudioController error via setErrorInfo only — it deliberately
  // does NOT touch the storm guard (no markTrackBroken, no formatErrorCountRef)
  // so the debug channel can never fake a storm or mark tracks broken. The
  // helper no-ops in production builds.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.PLAYER_ERROR, ({ code, message }) => {
      setErrorInfo({ code, message });
    });
  }, []);

  // Handle Keyboard Shortcuts (transport keys; seek/volume keys live in
  // SeekBar/VolumeSlider). Fix I: wrapped handlers so keyboard next/prev/play
  // also reset the storm guard (they are manual user actions).
  useKeyboardShortcuts({
    onNextTrack: handleManualNext,
    onPrevTrack: handleManualPrev,
    onTogglePlay: handleManualTogglePlay,
    onTogglePlayMode,
  });

  // Handle Play/Pause from Props (Syncing)
  useEffect(() => {
    if (!currentTrack) return;
    if (isPlaying) {
      void audio.playTrack(currentTrack, currentTrack.restoreTime);
    } else {
      void audio.pause();
    }
  }, [isPlaying, currentTrack, loadNonce, audio]);

  // Why: AudioController keeps its VI-language strings as-is (not translated);
  // PlayerBar maps the error codes to translated text so the toast matches the
  // active locale, and falls back to the raw message for unmapped codes.
  const ERROR_TEXT: Partial<Record<string, string>> = {
    network_interrupted: t("player.network_interrupted"),
    format_error: t("player.format_error"),
    advance_stopped: t("player.advance_stopped"),
  };
  const errorText = errorInfo
    ? (ERROR_TEXT[errorInfo.code] ?? errorInfo.message)
    : null;

  return (
    <div className="h-20 bg-white dark:bg-[#202124] flex items-center justify-between px-2 sm:px-4 shrink-0 z-10 transition-colors duration-300 relative">
      {/* Task 5 + row reorder (ADR 2026-08-17): mobile = 2 rows — on top,
          from left to right: track info → -5s/play/+5s transport → More options;
          FULL-WIDTH SeekBar below. Moving the seek row out of the 30%-wide
          TrackInfo column is what makes the drag surface span the whole bar
          (see SeekBar surfaceRef). Desktop below is untouched. */}
      {IS_MOBILE ? (
        <div className="flex flex-col h-full w-full min-w-0">
          <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
            {/* Left: Track Info */}
            <TrackInfo
              currentTrack={currentTrack}
              onExpandNowPlaying={onExpandNowPlaying}
            />

            {/* Center: 3-button transport (-5s / play / +5s) */}
            <TransportControls
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              isBuffering={isBuffering}
              isDownloading={isDownloading ?? false}
              hasError={errorInfo !== null}
              onRetry={handleManualRetry}
              playMode={playMode}
              onTogglePlay={handleManualTogglePlay}
              onPrevTrack={handleManualPrev}
              onNextTrack={handleManualNext}
              onTogglePlayMode={onTogglePlayMode}
              onRewind5={handleRewind5}
              onForward5={handleForward5}
            />

            {/* Right: More options — favorite state moved here from TrackInfo
                (was embedded in the track info column before the reorder). */}
            {currentTrack && (
              <MoreMenu
                track={currentTrack}
                isPlayerBarMode
                compact
                isFavorite={isLiked}
                onToggleFavorite={() => {
                  void toggleFavorite();
                }}
              />
            )}
          </div>
          <div className="w-full pb-1">
            <SeekBar currentTrack={currentTrack} audio={audio} />
          </div>
        </div>
      ) : (
        <>
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
              onRetry={handleManualRetry}
              playMode={playMode}
              onTogglePlay={handleManualTogglePlay}
              onPrevTrack={handleManualPrev}
              onNextTrack={handleManualNext}
              onTogglePlayMode={onTogglePlayMode}
              onRewind5={handleRewind5}
              onForward5={handleForward5}
            />
            <SeekBar currentTrack={currentTrack} audio={audio} />
          </div>

          {/* Right: Volume Controls. Mobile (Task 11 / Task 8B ADR): the
              on-screen slider is a no-op there — Android uses the hardware
              volume keys (ExoPlayer handles them natively), so the control
              lives only in this desktop branch. */}
          <VolumeSlider audio={audio} />
        </>
      )}

      {/* Error Toast */}
      <ErrorToast errorInfo={errorInfo} errorText={errorText} />
    </div>
  );
}

export const PlayerBar = memo(PlayerBarImpl, (prevProps, nextProps) => {
  return (
    prevProps.currentTrack?.id === nextProps.currentTrack?.id &&
    prevProps.isPlaying === nextProps.isPlaying &&
    prevProps.playMode === nextProps.playMode &&
    prevProps.isDownloading === nextProps.isDownloading &&
    prevProps.loadNonce === nextProps.loadNonce
  );
});
