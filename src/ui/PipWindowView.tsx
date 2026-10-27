import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Pause,
  PictureInPicture2,
  Play,
  SkipBack,
  SkipForward,
  Volume,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  VideoSurface,
  VIDEO_HOST_OWNER_CHANGED_EVENT,
} from "./NowPlaying/components/VideoSurface";
import { setVideoHostOwner } from "../lib/videoHost";
import {
  notifyPipReady,
  PIP_EVENTS,
  type PipActionName,
  type PipOwner,
  type PipStatePayload,
} from "../lib/pipWindow";
import { captureError } from "../utils/errorLog";
import { formatTime } from "../utils/formatTime";

const CONTROLS_HIDE_MS = 2_500;
/** Below this viewport height the fixed-px overlays would cover most of the
 *  picture, so the PiP chrome switches to a single compact row. */
const COMPACT_HEIGHT_PX = 340;
const MAIN_WINDOW_LABEL = "main";
/** If main never answers a close request (crashed/hung/reloaded), the PiP
 *  window must still be able to close itself after this bounded wait. */
const CLOSE_FALLBACK_MS = 4_000;

interface PipOwnerEvent {
  owner?: PipOwner;
}

function safeTime(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function safeVolume(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function logPipViewFailure(kind: string, error: unknown): void {
  void captureError({
    level: "warn",
    source: "PipWindowView",
    message: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
    kind,
  });
}

export function PipWindowView() {
  const { t } = useTranslation();
  const [state, setState] = useState<Partial<PipStatePayload>>({});
  const [ownerActive, setOwnerActive] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [compact, setCompact] = useState(
    () => window.innerHeight <= COMPACT_HEIGHT_PX,
  );
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const seekDraftRef = useRef<number | null>(null);
  const allowCloseRef = useRef(false);
  const pipActiveRef = useRef(false);
  const closeFallbackTimerRef = useRef<number | null>(null);

  const clearCloseFallback = useCallback(() => {
    if (closeFallbackTimerRef.current !== null) {
      window.clearTimeout(closeFallbackTimerRef.current);
      closeFallbackTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
    const run = (): void => {
      hideTimerRef.current = null;
      const active = document.activeElement;
      const focusInside =
        active instanceof HTMLElement &&
        active !== rootRef.current &&
        rootRef.current?.contains(active) === true &&
        active.matches(":focus-visible");
      if (focusInside) {
        hideTimerRef.current = window.setTimeout(run, CONTROLS_HIDE_MS);
        return;
      }
      setControlsVisible(false);
    };
    hideTimerRef.current = window.setTimeout(run, CONTROLS_HIDE_MS);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [scheduleHide]);

  useEffect(() => {
    const handleKeyDown = (): void => {
      revealControls();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [revealControls]);

  useEffect(() => {
    const onResize = (): void => {
      setCompact(window.innerHeight <= COMPACT_HEIGHT_PX);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const sendAction = useCallback(
    (action: PipActionName, payload?: unknown) => {
      void getCurrentWindow()
        .emitTo(MAIN_WINDOW_LABEL, PIP_EVENTS.action, { action, payload })
        .catch((error: unknown) => {
          logPipViewFailure(`action-${action}-failed`, error);
        });
    },
    [],
  );

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisteners: UnlistenFn[] = [];
    const lifecycle = { disposed: false };

    const track = async (promise: Promise<UnlistenFn>): Promise<boolean> => {
      const unlisten = await promise;
      if (lifecycle.disposed) {
        unlisten();
        return false;
      }
      unlisteners.push(unlisten);
      return true;
    };

    void (async () => {
      try {
        if (
          !(await track(
            listen<Partial<PipStatePayload>>(PIP_EVENTS.state, (event) => {
              setState((previous) => ({ ...previous, ...event.payload }));
            }),
          ))
        ) {
          return;
        }

        if (
          !(await track(
            listen<PipOwnerEvent>(PIP_EVENTS.owner, (event) => {
              const owner = event.payload.owner === "pip" ? "pip" : "main";
              allowCloseRef.current = owner === "main";
              pipActiveRef.current = owner === "pip";
              setVideoHostOwner(owner);
              // The surface dedupes the physical rect, so a retarget back to
              // an unchanged CSS box would otherwise never re-send it. This
              // event resets that dedupe AND re-sends rect + visibility.
              window.dispatchEvent(new Event(VIDEO_HOST_OWNER_CHANGED_EVENT));
              setOwnerActive(owner === "pip");
              if (owner === "main") clearCloseFallback();
              void appWindow
                .emitTo(MAIN_WINDOW_LABEL, PIP_EVENTS.ownerAck, { owner })
                .catch((error: unknown) => {
                  logPipViewFailure("owner-ack-failed", error);
                });
            }),
          ))
        ) {
          return;
        }

        if (
          !(await track(
            listen(PIP_EVENTS.release, () => {
              clearCloseFallback();
              allowCloseRef.current = true;
              pipActiveRef.current = false;
              setVideoHostOwner("main");
              setOwnerActive(false);
              void appWindow
                .emitTo(MAIN_WINDOW_LABEL, PIP_EVENTS.releaseAck)
                .catch((error: unknown) => {
                  logPipViewFailure("release-ack-failed", error);
                });
            }),
          ))
        ) {
          return;
        }

        if (
          !(await track(
            listen(PIP_EVENTS.requestReady, () => {
              notifyPipReady();
            }),
          ))
        ) {
          return;
        }

        if (
          !(await track(
            listen(PIP_EVENTS.refreshSurface, () => {
              setSurfaceGeneration((previous) => previous + 1);
            }),
          ))
        ) {
          return;
        }

        const unlistenClose = await appWindow.onCloseRequested((event) => {
          if (allowCloseRef.current || !pipActiveRef.current) return;
          event.preventDefault();
          void appWindow
            .emitTo(MAIN_WINDOW_LABEL, PIP_EVENTS.closeRequested)
            .catch((error: unknown) => {
              logPipViewFailure("close-request-emit-failed", error);
            });
          if (closeFallbackTimerRef.current !== null) return;
          // Main is the only component that can release the native surface.
          // If it is gone, waiting forever would make this window unclosable;
          // after the bound, force-destroy it (allow-destroy capability).
          closeFallbackTimerRef.current = window.setTimeout(() => {
            closeFallbackTimerRef.current = null;
            allowCloseRef.current = true;
            pipActiveRef.current = false;
            void appWindow.destroy().catch((error: unknown) => {
              logPipViewFailure("close-fallback-destroy-failed", error);
            });
          }, CLOSE_FALLBACK_MS);
        });
        if (lifecycle.disposed) {
          unlistenClose();
          return;
        }
        unlisteners.push(unlistenClose);

        notifyPipReady();
      } catch (error) {
        logPipViewFailure("listeners-failed", error);
      }
    })();

    return () => {
      lifecycle.disposed = true;
      clearCloseFallback();
      unlisteners.forEach((unlisten) => {
        unlisten();
      });
    };
  }, [clearCloseFallback]);

  const hasTrack = state.hasTrack === true;
  const isVideo = state.isVideo === true;
  const hasError = state.hasError === true;
  const hasEnded = state.hasEnded === true;
  const isPlaying = state.isPlaying === true;
  const isBuffering = state.isBuffering === true;
  const isMuted = state.isMuted === true;
  const volume = safeVolume(state.volume);
  const currentTime = safeTime(state.currentTime);
  const duration = safeTime(state.duration);
  const videoActive = hasTrack && isVideo && !hasError && !hasEnded;
  const hostActive = ownerActive && videoActive;
  const displayTitle =
    (state.title ?? "").trim() || t("player.picture_in_picture");
  const shownTime = seekDraft ?? currentTime;
  const seekMax = duration > 0 ? duration : 1;
  const seekValue = duration > 0 ? Math.min(shownTime, duration) : 0;
  const VolumeIcon =
    isMuted || volume === 0
      ? VolumeX
      : volume < 0.33
        ? Volume
        : volume < 0.66
          ? Volume1
          : Volume2;

  const handleSeekChange = (value: number): void => {
    if (!Number.isFinite(value) || hasEnded || hasError) return;
    seekDraftRef.current = value;
    setSeekDraft(value);
  };

  const commitSeek = (): void => {
    const value = seekDraftRef.current;
    seekDraftRef.current = null;
    setSeekDraft(null);
    if (value === null || hasEnded || hasError) return;
    setState((previous) => ({ ...previous, currentTime: value }));
    sendAction("seek", value);
  };

  const handleVolumeChange = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const nextVolume = Math.min(1, Math.max(0, value));
    setState((previous) => ({
      ...previous,
      volume: nextVolume,
      isMuted: nextVolume > 0 ? false : previous.isMuted === true,
    }));
    sendAction("setVolume", nextVolume);
  };

  const handleToggleMute = (): void => {
    setState((previous) => ({
      ...previous,
      isMuted: previous.isMuted !== true,
    }));
    sendAction("toggleMute");
  };

  const iconButtonClass =
    "flex h-8 w-8 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-brand-primary active:scale-95 disabled:opacity-40";
  const sliderClass =
    "h-1.5 min-w-0 cursor-pointer accent-brand-primary disabled:cursor-not-allowed disabled:opacity-40";

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

      <div
        className={`pointer-events-none absolute inset-0 z-20 ${
          compact ? "transition-none" : "transition-opacity duration-200"
        } ${controlsVisible ? "opacity-100" : "opacity-0"}`}
        aria-hidden={!controlsVisible}
        inert={!controlsVisible}
      >
        <div
          className={`pointer-events-auto absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b px-2 ${
            compact
              ? "from-black/70 via-black/30 to-transparent pb-2 pt-1"
              : "from-black/85 via-black/55 to-transparent pb-4 pt-2"
          } sm:gap-2 sm:px-3`}
          data-tauri-drag-region
          onPointerEnter={cancelHide}
          onPointerLeave={scheduleHide}
        >
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-white/90 sm:text-sm"
            data-tauri-drag-region
            title={displayTitle}
          >
            {displayTitle}
          </span>
          <button
            type="button"
            onClick={() => {
              sendAction("return");
            }}
            aria-label={t("player.pip.return_to_player")}
            title={t("player.pip.return_to_player")}
            className={iconButtonClass}
          >
            <PictureInPicture2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              sendAction("return");
            }}
            aria-label={t("player.pip.close")}
            title={t("player.pip.close")}
            className={iconButtonClass}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          className={`pointer-events-auto absolute inset-x-0 bottom-0 bg-gradient-to-t px-2 ${
            compact
              ? "from-black/70 via-black/35 to-transparent pb-1 pt-1"
              : "from-black/95 via-black/75 to-transparent pb-2 pt-8 sm:pb-3"
          } sm:px-3`}
          onPointerEnter={cancelHide}
          onPointerLeave={scheduleHide}
        >
          {!compact && (
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-white/80 sm:w-14 sm:text-xs">
                {formatTime(shownTime)}
              </span>
              <input
                type="range"
                min={0}
                max={seekMax}
                step={1}
                value={seekValue}
                disabled={duration <= 0 || hasEnded || hasError}
                aria-label={t("player.pip.seek")}
                onChange={(event) => {
                  handleSeekChange(Number(event.currentTarget.value));
                }}
                onPointerUp={commitSeek}
                onKeyUp={commitSeek}
                onBlur={commitSeek}
                className={`${sliderClass} flex-1`}
              />
              <span className="w-12 shrink-0 text-[11px] tabular-nums text-white/80 sm:w-14 sm:text-xs">
                {duration > 0 ? formatTime(duration) : "--:--"}
              </span>
            </div>
          )}

          <div
            className={`flex flex-nowrap items-center gap-1.5 ${
              compact ? "" : "mt-2 sm:gap-2"
            }`}
          >
            <button
              type="button"
              onClick={() => {
                sendAction("prev");
              }}
              disabled={!hasTrack}
              aria-label={t("player.prev")}
              title={t("player.prev")}
              className={iconButtonClass}
            >
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                sendAction("togglePlay");
              }}
              disabled={!hasTrack}
              aria-label={isPlaying ? t("player.pause") : t("player.play")}
              title={isPlaying ? t("player.pause") : t("player.play")}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-primary text-white shadow-md transition-colors hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-white active:scale-95 disabled:opacity-40"
            >
              {isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="ml-0.5 h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                sendAction("next");
              }}
              disabled={!hasTrack}
              aria-label={t("player.next")}
              title={t("player.next")}
              className={iconButtonClass}
            >
              <SkipForward className="h-4 w-4" />
            </button>

            {compact && (
              <input
                type="range"
                min={0}
                max={seekMax}
                step={1}
                value={seekValue}
                disabled={duration <= 0 || hasEnded || hasError}
                aria-label={t("player.pip.seek")}
                onChange={(event) => {
                  handleSeekChange(Number(event.currentTarget.value));
                }}
                onPointerUp={commitSeek}
                onKeyUp={commitSeek}
                onBlur={commitSeek}
                className={`${sliderClass} min-w-0 flex-1`}
              />
            )}

            <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
              <button
                type="button"
                onClick={handleToggleMute}
                aria-label={
                  isMuted ? t("player.pip.unmute") : t("player.pip.mute")
                }
                title={isMuted ? t("player.pip.unmute") : t("player.pip.mute")}
                className={iconButtonClass}
              >
                <VolumeIcon className="h-4 w-4" />
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                aria-label={t("player.pip.volume")}
                onChange={(event) => {
                  handleVolumeChange(Number(event.currentTarget.value));
                }}
                className={`${sliderClass} ${compact ? "hidden" : "w-20 sm:w-28"}`}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
