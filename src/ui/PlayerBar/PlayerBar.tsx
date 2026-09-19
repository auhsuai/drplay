import { memo, useCallback, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { List } from "lucide-react";
import { AudioController } from "../../lib/AudioController";
import { isForeignTrackEvent } from "../../lib/audioNativeEvents";
import { usePlayerStore } from "../../store/playerStore";
import type { PlayerBarProps } from "./types";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { TrackInfo } from "./TrackInfo";
import { TransportControls } from "./TransportControls";
import { SeekBar } from "../components/SeekBar";
import { VolumeSlider } from "./VolumeSlider";
import { ErrorToast } from "./ErrorToast";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";
import { resetAdvanceGuard, retryCurrentTrack } from "../../utils/playerError";

function PlayerBarImpl({
  currentTrack,
  isPlaying,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  isDownloading,
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
  // (P2-12-6): PlayerBar only RENDERS it from the store (the engine error
  // policy writes it — usePlayerPlaybackPolicy, R2.3); the storm guard +
  // manual retry live in utils/playerError.
  const errorInfo = usePlayerStore((state) => state.errorInfo);
  const setErrorInfo = usePlayerStore((state) => state.setErrorInfo);

  // Fix I: manual transport actions (buttons + keyboard) reset the guard
  // before delegating to the App-level handlers. Auto-advance
  // (usePlayerPlaybackPolicy's ended handler) calls the RAW onNextTrack — it
  // is the behavior being guarded and must never reset the counter. Retrying
  // is a manual action too: utils/playerError.retryCurrentTrack resets the
  // guard it shares.
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
  // R2.3: the error/ended/play policy handlers (mark-broken, storm guard,
  // advance decision, errorInfo writes, repeat-one replay) moved to
  // usePlayerPlaybackPolicy — mounted ONCE by usePlayer at app level. This
  // component keeps only its display subscriptions.
  // R3.5: the state→engine bridge effect is GONE — this surface is
  // observe-only. Every play/pause command is issued by the intent layer at
  // its commit point (usePlayerTrackPlayback / usePlayer), never by prop
  // changes here.
  // R2.1: the buffering handler reads the event's engine identity and drops
  // events of a DIFFERENT track than the store's current one — in the switch
  // window (store already on B, engine still emitting A's events) the old
  // track's buffering must not spin B's loader. Untagged events (no identity)
  // keep legacy behavior, as does a missing current track.
  useEffect(() => {
    const isForeign = (payload: { trackId?: string } | undefined) =>
      isForeignTrackEvent(payload, usePlayerStore.getState().currentTrack?.id);
    const unsubBuf = audio.on("buffering", ({ isBuffering, ...identity }) => {
      if (isForeign(identity)) return;
      setIsBuffering(isBuffering);
    });

    return () => {
      unsubBuf();
    };
  }, [audio]);

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
    // R3.5: loadNonce is no longer compared — its only consumer was the
    // removed bridge effect. The prop itself is still accepted (App passes
    // it) but intentionally ignored here until the dead wiring is removed.
    // The queue drawer lives in App/AppShell now; without this the memoized
    // bar would keep the stale button highlight + aria-expanded.
    prevProps.isQueueOpen === nextProps.isQueueOpen
  );
});
