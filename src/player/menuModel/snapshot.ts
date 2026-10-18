import { AudioController } from "../../lib/AudioController";
import {
  ASPECT_NO,
  getAbLoop,
  getAspectOverride,
  getAudioDelay,
  getAudioDevice,
  getAudioDevices,
  getChapters,
  getCrop,
  getCurrentChapter,
  getDeinterlace,
  getSecondarySubtitleId,
  getSpeed,
  getSubDelay,
  getSubtitleVisibility,
  getTrackList,
  getVideoDimensions,
  SPEED_NORMAL,
  type AbLoopPoints,
  type MpvAudioDevice,
  type MpvChapter,
  type MpvTrack,
} from "../../lib/mpvControl";
import { describeError } from "../../lib/mpvProtocol";
import { captureError } from "../../utils/errorLog";
import { usePlayerStore } from "../../store/playerStore";
import type { PlayMode, Track } from "../../types";

const LOGGER_SOURCE = "menuModel";

/** mpv `chapter` reports "no chapter" as null; -1 means "nothing checked". */
const NO_CHAPTER = -1;
/** Fallback when the deinterlace property cannot be read (mpv default). */
const DEINTERLACE_DEFAULT = "no";

// ---------------------------------------------------------------------------
// Snapshot (spec §22 — read ONCE when the menu opens)
// ---------------------------------------------------------------------------

export interface VideoMenuSnapshot {
  isPaused: boolean;
  isFullscreen: boolean;
  /** Audio-engine mute state (spec: the Mute item's checked flag). */
  isMuted: boolean;
  tracks: MpvTrack[];
  audioTrackId: number | null;
  subtitleTrackId: number | null;
  subtitleVisible: boolean;
  secondarySubtitleId: number | null;
  devices: MpvAudioDevice[];
  currentDevice: string | null;
  chapters: MpvChapter[];
  currentChapter: number;
  speed: number;
  /** mpv `video-aspect-override`: -2 auto, other numbers are overrides. */
  aspect: number;
  /** mpv `video-crop`: "" = none. */
  crop: string;
  deinterlace: string;
  subDelay: number;
  audioDelay: number;
  abLoop: AbLoopPoints;
  queue: Track[];
  currentTrackId: string | null;
  playMode: PlayMode;
  videoWidth: number | null;
  videoHeight: number | null;
}

/**
 * Warn once per failing operation for the whole session: a broken getter must
 * degrade the menu, not spam the log on every right-click.
 */
const warnedOperations = new Set<string>();

function warnSnapshotOnce(operation: string, error: unknown): void {
  if (warnedOperations.has(operation)) return;
  warnedOperations.add(operation);
  void captureError({
    level: "warn",
    source: LOGGER_SOURCE,
    message: `snapshot-get-failed ${operation}: ${describeError(error)}`,
    kind: "video-menu-snapshot-get-failed",
  });
}

/**
 * Every snapshot read goes through this: one failing getter degrades to its
 * fallback (the menu still opens, the submenu just lacks that data) and the
 * failure is logged once — never thrown.
 */
async function safeGet<T>(
  operation: string,
  read: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read();
  } catch (e: unknown) {
    warnSnapshotOnce(operation, e);
    return fallback;
  }
}

/** A 0 dimension means "unknown" (no video) — the menu works in nulls. */
function knownDimension(value: number): number | null {
  return value > 0 ? value : null;
}

export async function takeVideoMenuSnapshot(
  isFullscreen: boolean,
): Promise<VideoMenuSnapshot> {
  const [
    tracks,
    devices,
    currentDevice,
    chapters,
    rawCurrentChapter,
    speed,
    aspect,
    crop,
    deinterlace,
    subDelay,
    audioDelay,
    abLoop,
    subtitleVisible,
    secondarySubtitleId,
    dimensions,
    isMuted,
  ] = await Promise.all([
    safeGet("track-list", getTrackList, []),
    safeGet("audio-device-list", getAudioDevices, []),
    safeGet("audio-device", getAudioDevice, null),
    safeGet("chapter-list", getChapters, []),
    safeGet("chapter", getCurrentChapter, NO_CHAPTER),
    safeGet("speed", getSpeed, SPEED_NORMAL),
    safeGet("video-aspect-override", getAspectOverride, ASPECT_NO),
    safeGet("video-crop", getCrop, ""),
    safeGet("deinterlace", getDeinterlace, DEINTERLACE_DEFAULT),
    safeGet("sub-delay", getSubDelay, 0),
    safeGet("audio-delay", getAudioDelay, 0),
    safeGet("ab-loop", getAbLoop, { a: null, b: null }),
    safeGet("sub-visibility", getSubtitleVisibility, false),
    safeGet("secondary-sid", getSecondarySubtitleId, null),
    safeGet("video-dimensions", getVideoDimensions, { width: 0, height: 0 }),
    safeGet("is-muted", () => AudioController.getInstance().isMuted(), false),
  ]);

  const audioTracks = tracks.filter((track) => track.type === "audio");
  const subtitleTracks = tracks.filter((track) => track.type === "sub");
  const state = usePlayerStore.getState();

  return {
    isPaused: !state.isPlaying,
    isFullscreen,
    isMuted,
    tracks,
    audioTrackId: audioTracks.find((track) => track.selected)?.id ?? null,
    subtitleTrackId: subtitleTracks.find((track) => track.selected)?.id ?? null,
    subtitleVisible,
    secondarySubtitleId,
    devices,
    currentDevice,
    chapters,
    currentChapter: rawCurrentChapter ?? NO_CHAPTER,
    speed,
    aspect,
    crop,
    deinterlace,
    subDelay,
    audioDelay,
    abLoop,
    queue: state.playbackQueue,
    currentTrackId: state.currentTrack?.id ?? null,
    playMode: state.playMode,
    videoWidth: knownDimension(dimensions.width),
    videoHeight: knownDimension(dimensions.height),
  };
}
