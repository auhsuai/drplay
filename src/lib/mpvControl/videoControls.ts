import { join, pictureDir } from "@tauri-apps/api/path";
import { asNumber, asString, MPV_BOOL } from "../mpvProtocol";
import { ASPECT_AUTO, ASPECT_NO, SPEED_NORMAL } from "./calculations";
import {
  getProperty,
  invokeCommand,
  MPV_CONTROL_COMMANDS,
  MPV_CONTROL_PROPERTIES,
  setProperty,
  wrapError,
} from "./ipc";

export interface AbLoopPoints {
  a: number | null;
  b: number | null;
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
