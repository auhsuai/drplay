import {
  asBoolean,
  asNumber,
  asString,
  isRecord,
  MPV_BOOL,
} from "../mpvProtocol";
import {
  getProperty,
  invokeCommand,
  MPV_CONTROL_COMMANDS,
  MPV_CONTROL_PROPERTIES,
  setProperty,
} from "./ipc";

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
