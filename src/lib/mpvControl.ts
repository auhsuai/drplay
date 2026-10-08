import { invoke } from "@tauri-apps/api/core";
import { join, pictureDir } from "@tauri-apps/api/path";
import {
  asBoolean,
  asNumber,
  asString,
  describeError,
  isRecord,
  MPV_BOOL,
  MPV_COMMANDS,
  TAURI_COMMANDS,
} from "./mpvProtocol";

/**
 * mpvControl — property/command facade for player-UI features (track menus,
 * video adjustments, screenshots, media info). Same IPC tier as mpvAudio:
 * every call goes through the existing `mpv_command` / `mpv_get_property`
 * Tauri commands and the shared protocol constants (mpvProtocol.ts). This
 * module never touches the playback engine state — it is a request/response
 * surface only.
 *
 * Error contract (Luật 4): every invoke is try/caught and rethrown as an
 * Error carrying the operation context, so UI callers can surface it and
 * nothing is ever silently swallowed.
 */

const MPV_CONTROL_PROPERTIES = {
  trackList: "track-list",
  audioDeviceList: "audio-device-list",
  audioDevice: "audio-device",
  chapterList: "chapter-list",
  chapter: "chapter",
  speed: "speed",
  aspectOverride: "video-aspect-override",
  videoZoom: "video-zoom",
  videoPanX: "video-pan-x",
  videoPanY: "video-pan-y",
  videoCrop: "video-crop",
  deinterlace: "deinterlace",
  subDelay: "sub-delay",
  audioDelay: "audio-delay",
  abLoopA: "ab-loop-a",
  abLoopB: "ab-loop-b",
  subVisibility: "sub-visibility",
  secondarySid: "secondary-sid",
  sid: "sid",
  aid: "aid",
  vid: "vid",
  filename: "filename",
  mediaTitle: "media-title",
  duration: "duration",
  videoCodec: "video-codec",
  width: "width",
  height: "height",
  containerFps: "container-fps",
  pixelFormat: "video-params/pixelformat",
  audioCodecName: "audio-codec-name",
  hwdecCurrent: "hwdec-current",
  currentVo: "current-vo",
  videoBitrate: "video-bitrate",
  audioBitrate: "audio-bitrate",
} as const;

const MPV_CONTROL_COMMANDS = {
  add: "add",
  subAdd: "sub-add",
  screenshotToFile: "screenshot-to-file",
  /** mpv flag for `sub-add`: select the newly added track. */
  subAddSelectFlag: "select",
} as const;

export const ASPECT_AUTO = -2;
export const ASPECT_NO = -1;

/**
 * Aspect presets in cycle order (mpv `video-aspect-override` values: -2 auto,
 * -1 no override; 1 = square). Epsilon compare: mpv echoes back rounded floats
 * (16/9 comes back as 1.777778).
 */
const ASPECT_PRESETS: readonly number[] = [
  ASPECT_AUTO,
  16 / 9,
  4 / 3,
  21 / 9,
  1,
];
const ASPECT_EPSILON = 1e-3;

/** Playback-speed ladder (mpv `speed`), clamped at both ends. */
const SPEED_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const SPEED_NORMAL = 1;

const RATIO_EPSILON = 1e-3;

export type MpvTrackType = "video" | "audio" | "sub";

export interface MpvTrack {
  id: number;
  type: MpvTrackType;
  title?: string;
  lang?: string;
  codec?: string;
  channels?: number;
  isDefault: boolean;
  forced: boolean;
  selected: boolean;
  external: boolean;
}

export interface MpvAudioDevice {
  name: string;
  description: string;
}

export interface MpvChapter {
  title: string | null;
  time: number;
}

export interface AbLoopPoints {
  a: number | null;
  b: number | null;
}

export interface MediaInfoSnapshot {
  path: string | null;
  title: string | null;
  duration: number | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  pixelFormat: string | null;
  audioCodec: string | null;
  hwdec: string | null;
  videoOutput: string | null;
  videoBitrate: number | null;
  audioBitrate: number | null;
  audioTracks: MpvTrack[];
  subtitleTracks: MpvTrack[];
  audioTrackId: number | null;
  subtitleTrackId: number | null;
}

function wrapError(operation: string, cause: unknown): Error {
  return new Error(`mpvControl ${operation} failed: ${describeError(cause)}`);
}

async function getProperty(name: string): Promise<unknown> {
  try {
    return await invoke(TAURI_COMMANDS.mpvGetProperty, { prop: name });
  } catch (e: unknown) {
    throw wrapError(`get ${name}`, e);
  }
}

async function invokeCommand(cmd: string[]): Promise<void> {
  try {
    await invoke(TAURI_COMMANDS.mpvCommand, { cmd });
  } catch (e: unknown) {
    throw wrapError(`command ${cmd[0] ?? "unknown"}`, e);
  }
}

async function setProperty(name: string, value: string): Promise<void> {
  await invokeCommand([MPV_COMMANDS.setProperty, name, value]);
}

function trackTypeValue(id: number | "no"): string {
  return id === "no" ? MPV_BOOL.no : String(id);
}

const TRACK_TYPES: readonly MpvTrackType[] = ["video", "audio", "sub"];

function isTrackType(value: unknown): value is MpvTrackType {
  return (
    typeof value === "string" &&
    (TRACK_TYPES as readonly string[]).includes(value)
  );
}

function parseMpvTrack(entry: unknown): MpvTrack | null {
  if (!isRecord(entry)) return null;
  const id = asNumber(entry["id"]);
  const type = entry["type"];
  if (id === null || !isTrackType(type)) return null;
  const title = asString(entry["title"]);
  const lang = asString(entry["lang"]);
  const codec = asString(entry["codec"]);
  const channels = asNumber(entry["demux-channel-count"]);
  return {
    id,
    type,
    ...(title !== null ? { title } : {}),
    ...(lang !== null ? { lang } : {}),
    ...(codec !== null ? { codec } : {}),
    ...(channels !== null ? { channels } : {}),
    isDefault: asBoolean(entry["default"]) ?? false,
    forced: asBoolean(entry["forced"]) ?? false,
    selected: asBoolean(entry["selected"]) ?? false,
    external: asBoolean(entry["external"]) ?? false,
  };
}

export async function getTrackList(): Promise<MpvTrack[]> {
  const raw = await getProperty(MPV_CONTROL_PROPERTIES.trackList);
  if (!Array.isArray(raw)) return [];
  const tracks: MpvTrack[] = [];
  for (const entry of raw) {
    const track = parseMpvTrack(entry);
    if (track !== null) tracks.push(track);
  }
  return tracks;
}

export async function getAudioDevices(): Promise<MpvAudioDevice[]> {
  const raw = await getProperty(MPV_CONTROL_PROPERTIES.audioDeviceList);
  if (!Array.isArray(raw)) return [];
  const devices: MpvAudioDevice[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = asString(entry["name"]);
    if (name === null) continue;
    devices.push({ name, description: asString(entry["description"]) ?? "" });
  }
  return devices;
}

export async function getAudioDevice(): Promise<string | null> {
  return asString(await getProperty(MPV_CONTROL_PROPERTIES.audioDevice));
}

export async function getChapters(): Promise<MpvChapter[]> {
  const raw = await getProperty(MPV_CONTROL_PROPERTIES.chapterList);
  if (!Array.isArray(raw)) return [];
  const chapters: MpvChapter[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const time = asNumber(entry["time"]);
    if (time === null) continue;
    chapters.push({ title: asString(entry["title"]), time });
  }
  return chapters;
}

export async function getCurrentChapter(): Promise<number | null> {
  return asNumber(await getProperty(MPV_CONTROL_PROPERTIES.chapter));
}

/** mpv `sub-visibility`: false when unset/unreadable (mpv's own default). */
export async function getSubtitleVisibility(): Promise<boolean> {
  return (
    asBoolean(await getProperty(MPV_CONTROL_PROPERTIES.subVisibility)) ?? false
  );
}

/** mpv `secondary-sid`; unset ("no") narrows to null. */
export async function getSecondarySubtitleId(): Promise<number | null> {
  return asNumber(await getProperty(MPV_CONTROL_PROPERTIES.secondarySid));
}

/** Video frame dimensions; 0 = unknown (no video / property unavailable). */
export async function getVideoDimensions(): Promise<{
  width: number;
  height: number;
}> {
  const [rawWidth, rawHeight] = await Promise.all([
    getProperty(MPV_CONTROL_PROPERTIES.width),
    getProperty(MPV_CONTROL_PROPERTIES.height),
  ]);
  return { width: asNumber(rawWidth) ?? 0, height: asNumber(rawHeight) ?? 0 };
}

export async function getSpeed(): Promise<number> {
  return (
    asNumber(await getProperty(MPV_CONTROL_PROPERTIES.speed)) ?? SPEED_NORMAL
  );
}

export async function getAspectOverride(): Promise<number> {
  return (
    asNumber(await getProperty(MPV_CONTROL_PROPERTIES.aspectOverride)) ??
    ASPECT_NO
  );
}

export async function getVideoZoom(): Promise<number> {
  return asNumber(await getProperty(MPV_CONTROL_PROPERTIES.videoZoom)) ?? 0;
}

export async function getCrop(): Promise<string> {
  return asString(await getProperty(MPV_CONTROL_PROPERTIES.videoCrop)) ?? "";
}

export async function getDeinterlace(): Promise<string> {
  return (
    asString(await getProperty(MPV_CONTROL_PROPERTIES.deinterlace)) ?? "no"
  );
}

export async function getSubDelay(): Promise<number> {
  return asNumber(await getProperty(MPV_CONTROL_PROPERTIES.subDelay)) ?? 0;
}

export async function getAudioDelay(): Promise<number> {
  return asNumber(await getProperty(MPV_CONTROL_PROPERTIES.audioDelay)) ?? 0;
}

export async function getAbLoop(): Promise<AbLoopPoints> {
  const [rawA, rawB] = await Promise.all([
    getProperty(MPV_CONTROL_PROPERTIES.abLoopA),
    getProperty(MPV_CONTROL_PROPERTIES.abLoopB),
  ]);
  // mpv reports an unset point as the string "no" — asNumber narrows it to null.
  return { a: asNumber(rawA), b: asNumber(rawB) };
}

export async function getMediaInfo(): Promise<MediaInfoSnapshot> {
  const [
    path,
    title,
    duration,
    videoCodec,
    width,
    height,
    fps,
    pixelFormat,
    audioCodec,
    hwdec,
    videoOutput,
    videoBitrate,
    audioBitrate,
    tracks,
  ] = await Promise.all([
    getProperty(MPV_CONTROL_PROPERTIES.filename),
    getProperty(MPV_CONTROL_PROPERTIES.mediaTitle),
    getProperty(MPV_CONTROL_PROPERTIES.duration),
    getProperty(MPV_CONTROL_PROPERTIES.videoCodec),
    getProperty(MPV_CONTROL_PROPERTIES.width),
    getProperty(MPV_CONTROL_PROPERTIES.height),
    getProperty(MPV_CONTROL_PROPERTIES.containerFps),
    getProperty(MPV_CONTROL_PROPERTIES.pixelFormat),
    getProperty(MPV_CONTROL_PROPERTIES.audioCodecName),
    getProperty(MPV_CONTROL_PROPERTIES.hwdecCurrent),
    getProperty(MPV_CONTROL_PROPERTIES.currentVo),
    getProperty(MPV_CONTROL_PROPERTIES.videoBitrate),
    getProperty(MPV_CONTROL_PROPERTIES.audioBitrate),
    getTrackList(),
  ]);
  const audioTracks = tracks.filter((track) => track.type === "audio");
  const subtitleTracks = tracks.filter((track) => track.type === "sub");
  return {
    path: asString(path),
    title: asString(title),
    duration: asNumber(duration),
    videoCodec: asString(videoCodec),
    width: asNumber(width),
    height: asNumber(height),
    fps: asNumber(fps),
    pixelFormat: asString(pixelFormat),
    audioCodec: asString(audioCodec),
    hwdec: asString(hwdec),
    videoOutput: asString(videoOutput),
    videoBitrate: asNumber(videoBitrate),
    audioBitrate: asNumber(audioBitrate),
    audioTracks,
    subtitleTracks,
    audioTrackId: audioTracks.find((track) => track.selected)?.id ?? null,
    subtitleTrackId: subtitleTracks.find((track) => track.selected)?.id ?? null,
  };
}

export async function setAudioTrack(id: number | "no"): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.aid, trackTypeValue(id));
}

export async function setSubtitleTrack(id: number | "no"): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.sid, trackTypeValue(id));
}

export async function setVideoTrack(id: number | "no"): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.vid, trackTypeValue(id));
}

export async function addSubtitleFile(path: string): Promise<void> {
  await invokeCommand([
    MPV_CONTROL_COMMANDS.subAdd,
    path,
    MPV_CONTROL_COMMANDS.subAddSelectFlag,
  ]);
}

export async function setSecondarySubtitle(
  id: number | "no" | "auto",
): Promise<void> {
  const value = id === "auto" ? "auto" : trackTypeValue(id);
  await setProperty(MPV_CONTROL_PROPERTIES.secondarySid, value);
}

export async function toggleSubtitleVisibility(): Promise<void> {
  const visible =
    asBoolean(await getProperty(MPV_CONTROL_PROPERTIES.subVisibility)) ?? false;
  await setProperty(
    MPV_CONTROL_PROPERTIES.subVisibility,
    visible ? MPV_BOOL.no : MPV_BOOL.yes,
  );
}

export async function setAudioDevice(name: string): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.audioDevice, name);
}

export async function setChapter(index: number): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.chapter, String(index));
}

export async function setSpeed(speed: number): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.speed, String(speed));
}

export async function setAspectOverride(
  value: "auto" | "no" | number,
): Promise<void> {
  const raw =
    value === "auto" ? ASPECT_AUTO : value === "no" ? ASPECT_NO : value;
  await setProperty(MPV_CONTROL_PROPERTIES.aspectOverride, String(raw));
}

export async function resetVideoView(): Promise<void> {
  await Promise.all([
    setProperty(MPV_CONTROL_PROPERTIES.videoZoom, "0"),
    setProperty(MPV_CONTROL_PROPERTIES.videoPanX, "0"),
    setProperty(MPV_CONTROL_PROPERTIES.videoPanY, "0"),
  ]);
}

export async function addVideoZoom(delta: number): Promise<void> {
  await invokeCommand([
    MPV_CONTROL_COMMANDS.add,
    MPV_CONTROL_PROPERTIES.videoZoom,
    String(delta),
  ]);
}

export async function setCrop(crop: string): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.videoCrop, crop);
}

export async function setDeinterlace(
  value: "no" | "yes" | "auto",
): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.deinterlace, value);
}

export async function addSubDelay(deltaSeconds: number): Promise<void> {
  await invokeCommand([
    MPV_CONTROL_COMMANDS.add,
    MPV_CONTROL_PROPERTIES.subDelay,
    String(deltaSeconds),
  ]);
}

export async function resetSubDelay(): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.subDelay, "0");
}

export async function addAudioDelay(deltaSeconds: number): Promise<void> {
  await invokeCommand([
    MPV_CONTROL_COMMANDS.add,
    MPV_CONTROL_PROPERTIES.audioDelay,
    String(deltaSeconds),
  ]);
}

export async function resetAudioDelay(): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.audioDelay, "0");
}

function abLoopValue(seconds: number | null): string {
  return seconds === null ? MPV_BOOL.no : String(seconds);
}

export async function setAbLoopA(seconds: number | null): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.abLoopA, abLoopValue(seconds));
}

export async function setAbLoopB(seconds: number | null): Promise<void> {
  await setProperty(MPV_CONTROL_PROPERTIES.abLoopB, abLoopValue(seconds));
}

export async function clearAbLoop(): Promise<void> {
  await Promise.all([setAbLoopA(null), setAbLoopB(null)]);
}

/** Local-time timestamped screenshot name, e.g. DrPlay-20260102-030405.png. */
export function buildScreenshotName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `DrPlay-${date}-${time}.png`;
}

export async function takeScreenshot(): Promise<string> {
  let directory: string;
  try {
    directory = await pictureDir();
  } catch (e: unknown) {
    throw wrapError("pictureDir", e);
  }
  let path: string;
  try {
    path = await join(directory, buildScreenshotName(new Date()));
  } catch (e: unknown) {
    throw wrapError("screenshot path", e);
  }
  await invokeCommand([MPV_CONTROL_COMMANDS.screenshotToFile, path]);
  return path;
}

/**
 * Next/previous track id inside an already type-filtered track list.
 * Wraps around; ≤1 track is a no-op (null); a current id missing from the
 * list (or null) starts at the first/last entry for the given direction.
 */
export function nextTrackId(
  tracks: readonly MpvTrack[],
  currentId: number | null,
  direction: 1 | -1,
): number | null {
  if (tracks.length <= 1) return null;
  const fallback = direction === 1 ? tracks[0] : tracks[tracks.length - 1];
  if (currentId === null) return fallback?.id ?? null;
  const index = tracks.findIndex((track) => track.id === currentId);
  if (index === -1) return fallback?.id ?? null;
  const next = tracks[(index + direction + tracks.length) % tracks.length];
  return next?.id ?? null;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < ASPECT_EPSILON;
}

/**
 * Cycle the fixed aspect preset ring: -2 auto → 16/9 → 4/3 → 21/9 → 1 → -2.
 * An unknown current value (including -1 "no override") restarts the ring at
 * auto. Values were narrowed by getAspectOverride, so only the ring matters.
 */
export function aspectCycleValue(current: number): number {
  const index = ASPECT_PRESETS.findIndex((preset) =>
    nearlyEqual(preset, current),
  );
  if (index === -1) return ASPECT_PRESETS[0] ?? ASPECT_AUTO;
  return ASPECT_PRESETS[(index + 1) % ASPECT_PRESETS.length] ?? ASPECT_AUTO;
}

const DEINTERLACE_CYCLE: Record<string, "no" | "auto" | "yes"> = {
  no: "auto",
  auto: "yes",
  yes: "no",
};

export function deinterlaceCycle(current: string): "no" | "auto" | "yes" {
  return DEINTERLACE_CYCLE[current] ?? "no";
}

/**
 * Centered crop rect for the given target ratio, mpv `video-crop` syntax
 * "WxH+X+Y". A source already at the target ratio yields the full rect.
 */
export function cropRectFor(
  width: number,
  height: number,
  ratio: number,
): string {
  if (width <= 0 || height <= 0 || ratio <= 0) return "";
  const sourceRatio = width / height;
  if (Math.abs(sourceRatio - ratio) < RATIO_EPSILON) {
    return `${String(width)}x${String(height)}+0+0`;
  }
  if (sourceRatio > ratio) {
    const cropWidth = Math.round(height * ratio);
    const x = Math.round((width - cropWidth) / 2);
    return `${String(cropWidth)}x${String(height)}+${String(x)}+0`;
  }
  const cropHeight = Math.round(width / ratio);
  const y = Math.round((height - cropHeight) / 2);
  return `${String(width)}x${String(cropHeight)}+0+${String(y)}`;
}

/** Step the speed ladder towards `direction`, clamped to 0.5..2. */
export function speedStep(current: number, direction: 1 | -1): number {
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < SPEED_PRESETS.length; i++) {
    const preset = SPEED_PRESETS[i];
    if (preset === undefined) continue;
    const distance = Math.abs(preset - current);
    if (distance < best) {
      best = distance;
      index = i;
    }
  }
  const next = Math.min(
    Math.max(index + direction, 0),
    SPEED_PRESETS.length - 1,
  );
  return SPEED_PRESETS[next] ?? SPEED_NORMAL;
}
