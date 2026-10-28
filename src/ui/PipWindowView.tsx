import { useTranslation } from "react-i18next";
import { VideoSurface } from "./NowPlaying/components/VideoSurface";
import { PipControls } from "./PipWindow/PipControls";
import { safeTime, safeVolume } from "./PipWindow/pipWindowSizing";
import {
  usePipAspectLock,
  usePipChromeAutoHide,
  usePipWindowBridge,
} from "./PipWindow/usePipViewLifecycle";

export function PipWindowView() {
  const { t } = useTranslation();
  // Order matters: the chrome hook installs the CAPTURE-phase key block, and
  // the bridge installs the bubble-phase Ctrl+P listener. React runs effects in
  // declaration order, so keeping this call first preserves "block first, then
  // the one exception".
  const {
    rootRef,
    controlsVisible,
    compact,
    revealControls,
    scheduleHide,
    cancelHide,
  } = usePipChromeAutoHide();
  const {
    state,
    ownerActive,
    surfaceGeneration,
    sendAction,
    patchCurrentTime,
    patchVolume,
    toggleMute,
  } = usePipWindowBridge();

  const hasTrack = state.hasTrack === true;
  const isVideo = state.isVideo === true;
  const hasError = state.hasError === true;
  const hasEnded = state.hasEnded === true;
  const isPlaying = state.isPlaying === true;
  const isBuffering = state.isBuffering === true;
  const isMuted = state.isMuted === true;
  const isDownloading = state.isDownloading === true;
  const volume = safeVolume(state.volume);
  const currentTime = safeTime(state.currentTime);
  const duration = safeTime(state.duration);

  // Trigger key for the aspect apply. `state.trackId` is the STABLE identity of
  // the loaded media (`Track.id`), so two item-switches that happen to share a
  // title and a duration are still distinguishable — title+duration alone
  // silently skipped the re-apply for those and left the previous ratio locked
  // on a differently-shaped video. Time/buffering/volume/play-state updates do
  // not touch `trackId`, so the key stays identical while the same item plays
  // and no re-apply is triggered by ordinary playback traffic. The two gates
  // stay in the key because the apply is meaningful only for a loaded video.
  const aspectKey = [
    String(hasTrack),
    String(isVideo),
    state.trackId ?? "",
    (state.title ?? "").trim(),
    String(duration),
  ].join("|");

  usePipAspectLock({ hasTrack, isVideo, aspectKey });

  // Buffered segments travel as plain data (see BufferedRangePayload); a
  // missing field on an older publish degrades to "no buffer drawn" instead of
  // crashing the render.
  const buffered = state.buffered ?? [];
  const videoActive = hasTrack && isVideo && !hasError && !hasEnded;
  const hostActive = ownerActive && videoActive;
  const displayTitle =
    (state.title ?? "").trim() || t("player.picture_in_picture");

  // Optimistic local echo: the main window answers a seek with a fresh
  // pip-state, but that round-trip (and the engine's own timeupdate) can land
  // 250ms+ later, so waiting for it would leave the bar frozen where the user
  // released. Patch the local copy so the next render already shows the target
  // and the real payload only has to confirm it.
  const handleSeek = (time: number): void => {
    if (!Number.isFinite(time) || hasEnded || hasError) return;
    patchCurrentTime(time);
    sendAction("seek", time);
  };

  const handleVolumeChange = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const nextVolume = Math.min(1, Math.max(0, value));
    patchVolume(nextVolume);
    sendAction("setVolume", nextVolume);
  };

  const handleToggleMute = (): void => {
    toggleMute();
    sendAction("toggleMute");
  };

  return (
    <div
      ref={rootRef}
      role="presentation"
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onPointerEnter={revealControls}
      onFocusCapture={revealControls}
      onKeyDown={revealControls}
      className={`drplay-host-clear relative h-screen w-screen select-none overflow-hidden bg-black text-white ${
        controlsVisible ? "" : "cursor-none"
      }`}
    >
      <div className="absolute inset-0">
        <VideoSurface
          key={surfaceGeneration}
          owner="pip"
          active={hostActive}
          fill
          hasFirstFrame
          isPlaying={isPlaying}
          isBuffering={isBuffering}
          hasError={hasError}
          isEnded={hasEnded}
        />
      </div>

      {/* Opaque black cover for the (deliberately transparent) PiP page. The
          DComp video composites BELOW the webview, and the owner/first-frame
          state for THIS media load only reaches the main window — there is no
          PiP-side signal without a new event protocol, so `hasFirstFrame` stays
          true. This layer is therefore removed exactly when the host is really
          ours and playing (`hostActive`); it must never stay over a live video.
          A surface rebuild keeps `hostActive` true, so it cannot cover that
          gap; the cheaper protection there is that the render side keeps the
          previous surface bound until the replacement has a frame. */}
      {!hostActive && (
        <div className="absolute inset-0 z-[1] bg-black" aria-hidden="true" />
      )}

      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 text-center">
        {hasError && (
          <p className="max-w-xs rounded-lg bg-black/70 px-3 py-2 text-sm text-white/90">
            {t("player.pip.playback_error")}
          </p>
        )}
        {!hasError && hasEnded && (
          <p className="max-w-xs rounded-lg bg-black/70 px-3 py-2 text-sm text-white/90">
            {t("player.pip.video_ended")}
          </p>
        )}
        {!hasError && !hasEnded && !hasTrack && (
          <p className="max-w-xs rounded-lg bg-black/70 px-3 py-2 text-sm text-white/90">
            {t("player.no_track")}
          </p>
        )}
        {!hasError && !hasEnded && hasTrack && !isVideo && (
          <p className="max-w-xs rounded-lg bg-black/70 px-3 py-2 text-sm text-white/90">
            {t("player.pip.no_video")}
          </p>
        )}
      </div>

      {/* Always-present drag strip: the top bar below hides with the
          controls, so without this the window could not be moved once the
          auto-hide timer fires. It is 12px tall, transparent, and sits under
          the controls overlay (z-10 < z-20) so it never covers the bar or its
          buttons. Resizing is fully native (shadow:false in pipWindow.ts), so
          no JS resize zones are needed here. */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-3"
        data-tauri-drag-region
        aria-hidden="true"
      />

      <PipControls
        compact={compact}
        controlsVisible={controlsVisible}
        media={{
          title: displayTitle,
          hasTrack,
          hasError,
          hasEnded,
          isPlaying,
          isBuffering,
          isDownloading,
        }}
        timeline={{ currentTime, duration, buffered }}
        volume={{ value: volume, isMuted }}
        onAction={sendAction}
        onSeek={handleSeek}
        onVolumeChange={handleVolumeChange}
        onToggleMute={handleToggleMute}
        onChromeEnter={cancelHide}
        onChromeLeave={scheduleHide}
      />
    </div>
  );
}
