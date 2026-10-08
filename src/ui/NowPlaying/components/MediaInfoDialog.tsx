import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  getMediaInfo,
  type MediaInfoSnapshot,
  type MpvTrack,
} from "../../../lib/mpvControl";
import { describeError } from "../../../lib/mpvProtocol";
import { formatTrackLabel } from "../../../player/menuModel";

interface MediaInfoDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Placeholder for every missing value (spec: "—" khi không có dữ liệu). */
const NO_VALUE = "—";
const BYTES_PER_MEGABIT = 1_000_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const FPS_DECIMALS = 2;
const BITRATE_DECIMALS = 2;
const DIALOG_TITLE_ID = "media-info-title";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const secs = total % SECONDS_PER_MINUTE;
  if (hours > 0) {
    return `${String(hours)}:${pad2(minutes)}:${pad2(secs)}`;
  }
  return `${String(minutes)}:${pad2(secs)}`;
}

function formatResolution(
  width: number | null,
  height: number | null,
): string | null {
  if (width === null || height === null) return null;
  return `${String(width)}×${String(height)}`;
}

function formatFps(fps: number | null): string | null {
  if (fps === null) return null;
  return `${fps.toFixed(FPS_DECIMALS)} fps`;
}

function formatBitrate(bitsPerSecond: number | null): string | null {
  if (bitsPerSecond === null) return null;
  return `${(bitsPerSecond / BYTES_PER_MEGABIT).toFixed(BITRATE_DECIMALS)} Mbps`;
}

/** Join the present parts; a row with nothing present reads as NO_VALUE. */
function joinedValue(parts: (string | null)[]): string {
  const present = parts.filter(
    (part): part is string => part !== null && part !== "",
  );
  return present.length > 0 ? present.join(" · ") : NO_VALUE;
}

function InfoRow({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd
        data-testid={testId}
        className="text-gray-900 dark:text-white break-all"
      >
        {value}
      </dd>
    </div>
  );
}

interface TrackRow {
  track: MpvTrack;
  fallback: string;
}

function trackRows(
  info: MediaInfoSnapshot,
  audioFallback: (index: number) => string,
  subtitleFallback: (index: number) => string,
): TrackRow[] {
  return [
    ...info.audioTracks.map((track, index) => ({
      track,
      fallback: audioFallback(index),
    })),
    ...info.subtitleTracks.map((track, index) => ({
      track,
      fallback: subtitleFallback(index),
    })),
  ];
}

/**
 * Media Information dialog (D2b). Data comes from the mpvControl facade on
 * every open; a failed read renders the error inside the dialog instead of
 * taking the surface down. Escape is handled in the CAPTURE phase and stopped
 * there, so it closes this dialog before useNowPlayingShortcuts can peel
 * fullscreen/overlay underneath it.
 */
export function MediaInfoDialog({ open, onClose }: MediaInfoDialogProps) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<MediaInfoSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Monotonic session id: a response from a previous open must never overwrite
  // the state of a newer one (open -> close -> open while a fetch is in flight).
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    void (async () => {
      // New open session: back to the loading state before the fetch.
      setInfo(null);
      setError(null);
      try {
        const snapshot = await getMediaInfo();
        if (requestIdRef.current === requestId) setInfo(snapshot);
      } catch (e: unknown) {
        if (requestIdRef.current === requestId) setError(describeError(e));
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      window.removeEventListener("keydown", handleEscape, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const rows =
    info !== null
      ? trackRows(
          info,
          (index) => t("player.menu.audio_track_n", { n: index + 1 }),
          (index) => t("player.menu.subtitle_track_n", { n: index + 1 }),
        )
      : [];
  const selectedAudioChannels =
    info?.audioTracks.find((track) => track.selected)?.channels ?? null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      role="presentation"
      data-testid="media-info-backdrop"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={DIALOG_TITLE_ID}
        data-testid="media-info-dialog"
        className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl bg-white dark:bg-[#1a1b1e] shadow-2xl p-6 animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between mb-4">
          <h2
            id={DIALOG_TITLE_ID}
            className="text-lg font-bold text-gray-900 dark:text-white"
          >
            {t("player.media_info.title")}
          </h2>
          <button
            type="button"
            data-testid="media-info-close"
            aria-label={t("common.close")}
            onClick={onClose}
            className="p-1 rounded-full text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error !== null ? (
          <p data-testid="media-info-error" className="text-sm text-red-500">
            {error}
          </p>
        ) : info === null ? (
          <p
            data-testid="media-info-loading"
            className="text-sm text-gray-500 dark:text-gray-400"
          >
            {t("player.media_info.loading")}
          </p>
        ) : (
          <dl className="space-y-3 text-sm">
            <InfoRow
              testId="media-info-file"
              label={t("player.media_info.file")}
              value={info.path ?? info.title ?? NO_VALUE}
            />
            <InfoRow
              testId="media-info-duration"
              label={t("player.media_info.duration")}
              value={formatDuration(info.duration) ?? NO_VALUE}
            />
            <InfoRow
              testId="media-info-video"
              label={t("player.media_info.video")}
              value={joinedValue([
                info.videoCodec,
                formatResolution(info.width, info.height),
                formatFps(info.fps),
                info.pixelFormat,
              ])}
            />
            <InfoRow
              testId="media-info-audio"
              label={t("player.media_info.audio")}
              value={joinedValue([
                info.audioCodec,
                selectedAudioChannels !== null
                  ? `${String(selectedAudioChannels)} ch`
                  : null,
              ])}
            />
            <InfoRow
              testId="media-info-hwdec"
              label={t("player.media_info.hwdec")}
              value={info.hwdec ?? NO_VALUE}
            />
            <InfoRow
              testId="media-info-output"
              label={t("player.media_info.output")}
              value={info.videoOutput ?? NO_VALUE}
            />
            <InfoRow
              testId="media-info-bitrate"
              label={t("player.media_info.bitrate")}
              value={
                formatBitrate(info.videoBitrate ?? info.audioBitrate) ??
                NO_VALUE
              }
            />
            <div className="flex gap-3">
              <dt className="w-32 shrink-0 text-gray-500 dark:text-gray-400">
                {t("player.media_info.tracks")}
              </dt>
              <dd
                data-testid="media-info-tracks"
                className="text-gray-900 dark:text-white"
              >
                {rows.length === 0 ? (
                  NO_VALUE
                ) : (
                  <ul className="space-y-1">
                    {rows.map(({ track, fallback }) => (
                      <li key={`${track.type}-${String(track.id)}`}>
                        {track.selected ? "✓ " : ""}
                        {formatTrackLabel(track, fallback)}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}
