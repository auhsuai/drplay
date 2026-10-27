import i18next from "i18next";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ASPECT_AUTO,
  addSubtitleFile,
  addVideoZoom,
  clearAbLoop,
  cropRectFor,
  resetVideoView,
  setAbLoopA,
  setAbLoopB,
  setAspectOverride,
  setAudioDevice,
  setAudioTrack,
  setChapter,
  setCrop,
  setDeinterlace,
  setSecondarySubtitle,
  setSpeed,
  setSubtitleTrack,
  setVideoTrack,
} from "../../lib/mpvControl";
import { describeError } from "../../lib/mpvProtocol";
import { showSuccessToast } from "../../utils/simpleToast";
import {
  PLAYER_COMMAND_IDS,
  VIDEO_ZOOM_STEP,
  type PlayerCommandContext,
  type PlayerCommandId,
} from "../commands";
import { runPlayerCommand } from "../usePlayerCommands";
import {
  DEINTERLACE_MENU_PRESETS,
  MENU_IDS,
  MENU_PREFIXES,
  REPEAT_MENU_PRESETS,
  TRACK_NONE,
} from "./constants";
import type { VideoMenuSnapshot } from "./snapshot";

const AUDIO_DEVICE_NAME_CONTEXT = "audio device name";

const SUBTITLE_FILE_EXTENSIONS: readonly string[] = [
  "srt",
  "ass",
  "ssa",
  "sub",
  "vtt",
];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const COMMAND_ID_SET: ReadonlySet<string> = new Set(
  Object.values(PLAYER_COMMAND_IDS),
);

function decodeSegment(segment: string, context: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (e: unknown) {
    throw new Error(`Invalid ${context}: ${describeError(e)}`);
  }
}

function parseTrackRef(segment: string, context: string): number | "no" {
  if (segment === TRACK_NONE) return "no";
  const id = Number(segment);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid ${context} track id: ${segment}`);
  }
  return id;
}

function parseRatio(value: string): number | null {
  const parts = value.split("/");
  if (parts.length === 1) {
    const single = Number(value);
    return Number.isFinite(single) ? single : null;
  }
  if (parts.length !== 2) return null;
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  return numerator / denominator;
}

function runDelayAlias(
  segment: string,
  aliases: Readonly<Record<string, PlayerCommandId>>,
  ctx: PlayerCommandContext,
): void {
  const commandId = aliases[segment];
  if (commandId === undefined) {
    throw new Error(`Unknown delay action: ${segment}`);
  }
  runPlayerCommand(commandId, ctx);
}

async function runZoomAction(segment: string): Promise<void> {
  switch (segment) {
    case "reset":
      await resetVideoView();
      return;
    case "in":
      await addVideoZoom(VIDEO_ZOOM_STEP);
      return;
    case "out":
      await addVideoZoom(-VIDEO_ZOOM_STEP);
      return;
    default:
      throw new Error(`Unknown zoom action: ${segment}`);
  }
}

async function runCropAction(
  segment: string,
  s: VideoMenuSnapshot,
): Promise<void> {
  if (segment === "none") {
    await setCrop("");
    return;
  }
  const ratio = parseRatio(segment);
  if (ratio === null || ratio <= 0) {
    throw new Error(`Invalid crop ratio: ${segment}`);
  }
  const { videoWidth, videoHeight } = s;
  if (
    videoWidth === null ||
    videoHeight === null ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    throw new Error(
      "Cannot apply a crop preset: the video dimensions are unknown",
    );
  }
  const rect = cropRectFor(videoWidth, videoHeight, ratio);
  if (rect === "") {
    throw new Error(`Cannot compute a crop rect for ratio ${segment}`);
  }
  await setCrop(rect);
}

async function pickSubtitleFile(): Promise<void> {
  let selected: string | null;
  try {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: i18next.t("player.menu.subtitle_files"),
          extensions: [...SUBTITLE_FILE_EXTENSIONS],
        },
      ],
    });
    selected = typeof picked === "string" ? picked : null;
  } catch (e: unknown) {
    throw new Error(`subtitle picker failed: ${describeError(e)}`);
  }
  // Cancelled / no selection: nothing to add.
  if (selected === null) return;
  await addSubtitleFile(selected);
  showSuccessToast(i18next.t("player.menu.add_subtitle_success"));
}

function runRepeatAction(segment: string, ctx: PlayerCommandContext): void {
  const mode = REPEAT_MENU_PRESETS.find((preset) => preset.mode === segment);
  if (mode === undefined) {
    throw new Error(`Unknown repeat mode: ${segment}`);
  }
  ctx.setPlayMode(mode.mode);
}

function selectQueuedTrack(
  segment: string,
  ctx: PlayerCommandContext,
  s: VideoMenuSnapshot,
): void {
  const trackId = decodeSegment(segment, "queue track id");
  const track = s.queue.find((candidate) => candidate.id === trackId);
  if (track === undefined) {
    throw new Error(`Queue track not found in the snapshot: ${trackId}`);
  }
  ctx.selectTrack(track);
}

/**
 * Run the item the native menu returned. `PLAYER_*` ids go through the shared
 * command registry; `menu:*` ids dispatch to the mpvControl facade (or reuse a
 * command when one already implements the exact action). Unknown ids throw —
 * the caller surfaces the failure, nothing is ever swallowed.
 */
export async function runMenuEntry(
  id: string,
  ctx: PlayerCommandContext,
  s: VideoMenuSnapshot,
): Promise<void> {
  if (COMMAND_ID_SET.has(id)) {
    runPlayerCommand(id as PlayerCommandId, ctx);
    return;
  }

  if (id.startsWith(MENU_PREFIXES.audioDelay)) {
    runDelayAlias(
      id.slice(MENU_PREFIXES.audioDelay.length),
      {
        down: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN,
        up: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP,
        reset: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET,
      },
      ctx,
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.subDelay)) {
    runDelayAlias(
      id.slice(MENU_PREFIXES.subDelay.length),
      {
        down: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_DOWN,
        up: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_UP,
        reset: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_RESET,
      },
      ctx,
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.audio)) {
    await setAudioTrack(
      parseTrackRef(id.slice(MENU_PREFIXES.audio.length), "audio"),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.video)) {
    await setVideoTrack(
      parseTrackRef(id.slice(MENU_PREFIXES.video.length), "video"),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.sub)) {
    await setSubtitleTrack(
      parseTrackRef(id.slice(MENU_PREFIXES.sub.length), "subtitle"),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.secondary)) {
    await setSecondarySubtitle(
      parseTrackRef(
        id.slice(MENU_PREFIXES.secondary.length),
        "secondary subtitle",
      ),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.device)) {
    await setAudioDevice(
      decodeSegment(
        id.slice(MENU_PREFIXES.device.length),
        AUDIO_DEVICE_NAME_CONTEXT,
      ),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.chapter)) {
    const index = Number(id.slice(MENU_PREFIXES.chapter.length));
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid chapter index: ${id}`);
    }
    await setChapter(index);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.speed)) {
    const speed = Number(id.slice(MENU_PREFIXES.speed.length));
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error(`Invalid speed value: ${id}`);
    }
    await setSpeed(speed);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.aspect)) {
    const segment = id.slice(MENU_PREFIXES.aspect.length);
    if (segment === String(ASPECT_AUTO)) {
      await setAspectOverride("auto");
      return;
    }
    const ratio = parseRatio(segment);
    if (ratio === null || ratio <= 0) {
      throw new Error(`Invalid aspect value: ${segment}`);
    }
    await setAspectOverride(ratio);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.zoom)) {
    await runZoomAction(id.slice(MENU_PREFIXES.zoom.length));
    return;
  }
  if (id.startsWith(MENU_PREFIXES.crop)) {
    await runCropAction(id.slice(MENU_PREFIXES.crop.length), s);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.deinterlace)) {
    const segment = id.slice(MENU_PREFIXES.deinterlace.length);
    const preset = DEINTERLACE_MENU_PRESETS.find(
      (candidate) => candidate.value === segment,
    );
    if (preset === undefined) {
      throw new Error(`Unknown deinterlace mode: ${segment}`);
    }
    await setDeinterlace(preset.value);
    return;
  }
  if (id === MENU_IDS.setA) {
    await setAbLoopA(ctx.audio.getCurrentTime());
    return;
  }
  if (id === MENU_IDS.setB) {
    await setAbLoopB(ctx.audio.getCurrentTime());
    return;
  }
  if (id === MENU_IDS.clearAb) {
    await clearAbLoop();
    return;
  }
  if (id === MENU_IDS.addSubtitle) {
    await pickSubtitleFile();
    return;
  }
  if (id.startsWith(MENU_PREFIXES.repeat)) {
    runRepeatAction(id.slice(MENU_PREFIXES.repeat.length), ctx);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.queue)) {
    selectQueuedTrack(id.slice(MENU_PREFIXES.queue.length), ctx, s);
    return;
  }
  if (id === MENU_IDS.pip) {
    ctx.enterPip?.();
    return;
  }

  throw new Error(`Unknown menu entry id: ${id}`);
}
