import { useCallback, useEffect, useState } from "react";
import type { PlayerErrorInfo } from "../../store/playerStore";
import type { Track } from "../../types";
import { AudioController } from "../../lib/AudioController";
import { isForeignTrackEvent } from "../../lib/audioNativeEvents";
import { usePlayerStore } from "../../store/playerStore";
import { resetAdvanceGuard } from "../../utils/playerError";
import { classifyMediaKind, MEDIA_KIND_VIDEO } from "../../utils/mediaKind";
import { shouldShowVideoHost } from "../../lib/videoHost";
import { useVideoFirstFrame } from "../../player/useVideoFirstFrame";
import { useNowPlayingMetadata } from "./hooks/useNowPlayingMetadata";

export interface NowPlayingViewModelParams {
  currentTrack: Track | null;
  token: string | null;
  isOpen: boolean;
  isShellLocked: boolean;
  isPipActive: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
}

export interface NowPlayingViewModel {
  isDownloading: boolean;
  errorInfo: PlayerErrorInfo | null;
  isVideoTrack: boolean;
  showVideoHost: boolean;
  hasVideoFrame: boolean;
  videoReady: boolean;
  isBuffering: boolean;
  isEnded: boolean;
  coverUrl: string | null;
  setCoverUrl: (url: string | null) => void;
  realTitle: string;
  realArtist: string;
  bgColor: string;
  bgPalette: string[];
  handleManualTogglePlay: () => void;
  handleManualNext: () => void;
  handleManualPrev: () => void;
}

export function useNowPlayingViewModel({
  currentTrack,
  token,
  isOpen,
  isShellLocked,
  isPipActive,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
}: NowPlayingViewModelParams): NowPlayingViewModel {
  // Same store source PlayerBar's transport row resolves isDownloading from
  // (playerStore.isDownloading, set by usePlayer.handlePlayTrack) — it covers
  // the "preparing to play" intent window (token fetch → stream URL →
  // loadfile) where the buffering event has not fired yet.
  const isDownloading = usePlayerStore((state) => state.isDownloading);

  // Shared error surface (P2-12-6): PlayerBar publishes the error + storm
  // banner here, and the full-screen view renders the same banner inline +
  // the retry affordance — without duplicating the audio error subscription
  // or the storm guard (those stay single-owner in PlayerBar/playerError).
  const errorInfo = usePlayerStore((state) => state.errorInfo);

  // Media kind of the loaded track (same derivation mpvAudio.loadTrack uses for
  // the `video` property). A video track replaces the cover-art square with the
  // VideoSurface; an audio track is untouched by anything in this slice.
  const isVideoTrack =
    currentTrack !== null &&
    classifyMediaKind(currentTrack.originalName ?? currentTrack.title) ===
      MEDIA_KIND_VIDEO;

  // Ended (F5): mpv's `end-file` already reaches the app as the `ended` engine
  // event (mpvProtocol -> mpvAudio -> AudioController.on("ended")) — the very
  // same event that drives auto-advance in usePlayerPlaybackPolicy. The surface
  // listens to it here rather than inventing a second subscription, so a
  // finished video stops showing a live-looking surface (frozen last frame)
  // while the queue advances. Cleared on the next track, because the store's
  // currentTrack changing means playback restarted.
  const [isEnded, setIsEnded] = useState(false);
  useEffect(() => {
    const audio = AudioController.getInstance();
    return audio.on("ended", (identity) => {
      if (
        isForeignTrackEvent(
          identity,
          usePlayerStore.getState().currentTrack?.id,
        )
      ) {
        return;
      }
      setIsEnded(true);
    });
  }, []);

  const currentTrackId = currentTrack?.id;
  useEffect(() => {
    // Deliberate: "commit track mới → effect reset chạy" là thứ tự mà hành vi
    // hiện tại (và test 'a new track clears the ended state') dựa vào; reset
    // trong render sẽ đổi số lần render. Chuyển nguyên văn từ NowPlayingView.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsEnded(false);
  }, [currentTrackId]);

  const showVideoHost =
    shouldShowVideoHost({
      hasTrack: currentTrack !== null,
      isVideo: isVideoTrack,
      isOpen,
      isShellLocked,
      hasError: errorInfo !== null,
      hasEnded: isEnded,
    }) && !isPipActive;

  // Has the render thread presented a frame of THIS media load yet? Host
  // visibility cannot answer that — it flips when a track is SELECTED, which is
  // long before mpv has anything to show — and until a frame exists the video
  // rect must stay opaque, because the whole page is deliberately transparent
  // while the host is visible (App.css `html.drplay-host-visible`).
  //
  // The readiness belongs to ONE LOAD, not to one track: the engine mints a
  // new attempt id per load (R2.1) and publishes it with the buffering event
  // it raises at the START of every load — before any frame of that load can
  // be presented. Keying the readiness on (track, attempt) is what makes a
  // RE-LOAD of the same track (retry, load-deadline restart, replay after
  // end-file) drop the previous attempt's readiness: the new load has no
  // frame of its own yet, and reusing the old answer left the video rect
  // unpainted (a transparent hole) with no startup spinner.
  //
  // The key stays null until the engine has published the attempt of the
  // CURRENT track: the pull complement (`video_host_first_frame_presented`)
  // answers for the load in flight, so asking it before this load started
  // would report the PREVIOUS load's frame. An AUDIO track never gets a key
  // at all — it has no frame to wait for, so it must not subscribe to the
  // signal or spend an IPC round trip on it.
  const [loadIdentity, setLoadIdentity] = useState<{
    trackId: string;
    attempt: number;
  } | null>(null);
  const videoFrameKey =
    isVideoTrack &&
    currentTrackId !== undefined &&
    loadIdentity !== null &&
    loadIdentity.trackId === currentTrackId
      ? `${currentTrackId}#${String(loadIdentity.attempt)}`
      : null;
  const hasVideoFrame = useVideoFirstFrame(videoFrameKey);
  const videoReady = showVideoHost && hasVideoFrame;

  const { coverUrl, setCoverUrl, realTitle, realArtist, bgColor, bgPalette } =
    useNowPlayingMetadata(currentTrack, token);

  // Buffering state for the play-button spinner — the ENGINE's signal, same
  // source as PlayerBar (the "buffering" event the engine raises for its
  // startup loader and for a confirmed cache stall). R2.1: identity guard
  // like PlayerBar — a stale track's buffering event must not spin this view.
  // The engine never raises it while the user paused, so a paused track
  // never shows a spinner here.
  //
  // The event also carries the engine's LOAD IDENTITY: the attempt id is
  // minted per load, so it changes on every re-load of the same track. That
  // is the signal the first-frame readiness is keyed on (see above).
  const [isBuffering, setIsBuffering] = useState(false);
  useEffect(() => {
    const audio = AudioController.getInstance();
    return audio.on("buffering", ({ isBuffering: buffering, ...identity }) => {
      if (
        isForeignTrackEvent(
          identity,
          usePlayerStore.getState().currentTrack?.id,
        )
      ) {
        return;
      }
      setIsBuffering(buffering);
      const { trackId, attempt } = identity;
      if (trackId !== undefined && attempt !== undefined) {
        setLoadIdentity((previous) =>
          previous !== null &&
          previous.trackId === trackId &&
          previous.attempt === attempt
            ? previous
            : { trackId, attempt },
        );
      }
    });
  }, []);

  // F7-7 parity: the full-screen transport buttons are manual transport
  // actions, exactly like PlayerBar's (which reset the shared storm guard in
  // its own wrappers). Wrap locally and hand the wrapped versions down —
  // retryCurrentTrack already resets the guard it shares.
  const handleManualTogglePlay = useCallback(() => {
    resetAdvanceGuard();
    onTogglePlay();
  }, [onTogglePlay]);

  const handleManualNext = useCallback(() => {
    resetAdvanceGuard();
    onNextTrack();
  }, [onNextTrack]);

  const handleManualPrev = useCallback(() => {
    resetAdvanceGuard();
    onPrevTrack();
  }, [onPrevTrack]);

  return {
    isDownloading,
    errorInfo,
    isVideoTrack,
    showVideoHost,
    hasVideoFrame,
    videoReady,
    isBuffering,
    isEnded,
    coverUrl,
    setCoverUrl,
    realTitle,
    realArtist,
    bgColor,
    bgPalette,
    handleManualTogglePlay,
    handleManualNext,
    handleManualPrev,
  };
}
