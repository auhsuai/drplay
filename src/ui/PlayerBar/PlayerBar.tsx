import { memo, useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AudioController } from "../../lib/AudioController";
import type { PlayerBarProps } from "./types";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { TrackInfo } from "./TrackInfo";
import { TransportControls } from "./TransportControls";
import { SeekBar } from "./SeekBar";
import { VolumeSlider } from "./VolumeSlider";
import { ErrorToast } from "./ErrorToast";

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
  const audio = AudioController.getInstance();

  // Local UI state (không gây ảnh hưởng global). Seek/volume/favorite state
  // is owned by SeekBar/VolumeSlider/TrackInfo — this composition layer only
  // keeps transport-level state (PLAN v2 — render-critical isolation).
  const [isBuffering, setIsBuffering] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{
    message: string;
    code: string;
  } | null>(null);

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
      setErrorInfo(err);
    });
    // A `play` event is the native "playback actually resumed" signal — it
    // fires after a successful auto-retry, so the stale error banner (and its
    // RefreshCw button) must not outlive the recovery.
    const unsubPlay = audio.on("play", () => {
      setErrorInfo(null);
    });
    const unsubEnded = audio.on("ended", () => {
      onNextTrack(true);
    });

    return () => {
      unsubBuf();
      unsubErr();
      unsubPlay();
      unsubEnded();
    };
  }, [onNextTrack, audio]);

  // Handle Keyboard Shortcuts (transport keys; seek/volume keys live in
  // SeekBar/VolumeSlider)
  useKeyboardShortcuts({
    onNextTrack,
    onPrevTrack,
    onTogglePlay,
    onTogglePlayMode,
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

  // Retry path for the transport play button (replays from the restore time).
  const retryPlayback = () => {
    if (currentTrack) {
      void audio.playTrack(currentTrack, currentTrack.restoreTime);
    }
  };

  // Why: AudioController keeps its VI-language strings as-is (not translated);
  // PlayerBar maps the error codes to translated text so the toast matches the
  // active locale, and falls back to the raw message for unmapped codes.
  const errorText = errorInfo
    ? errorInfo.code === "network_interrupted"
      ? t("player.network_interrupted")
      : errorInfo.code === "format_error"
        ? t("player.format_error")
        : errorInfo.message
    : null;

  return (
    <div className="h-20 bg-white dark:bg-[#202124] flex items-center justify-between px-2 sm:px-4 shrink-0 z-10 transition-colors duration-300 relative">
      {/* Left: Track Info */}
      <TrackInfo
        currentTrack={currentTrack}
        onExpandNowPlaying={onExpandNowPlaying}
      />

      {/* Center: Controls */}
      <div className="flex flex-col items-center justify-center flex-1 max-w-[722px] px-2 min-w-[200px]">
        <TransportControls
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          isBuffering={isBuffering}
          isDownloading={isDownloading ?? false}
          hasError={errorInfo !== null}
          onRetry={retryPlayback}
          playMode={playMode}
          onTogglePlay={onTogglePlay}
          onPrevTrack={onPrevTrack}
          onNextTrack={onNextTrack}
          onTogglePlayMode={onTogglePlayMode}
        />
        <SeekBar currentTrack={currentTrack} audio={audio} />
      </div>

      {/* Right: Volume Controls */}
      <VolumeSlider audio={audio} />

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
