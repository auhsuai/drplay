import { join, pictureDir } from "@tauri-apps/api/path";
import { asNumber, asString, MPV_BOOL } from "../mpvProtocol";
import { captureError } from "../../utils/errorLog";
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

const ASPECT_LOG_SOURCE = "mpvControl/videoControls";

/** Report one failed step of the aspect ladder without ever rethrowing. */
function logAspectFailure(kind: string, error: unknown): void {
  void captureError({
    level: "warn",
    source: ASPECT_LOG_SOURCE,
    message: `${kind} failed: ${error instanceof Error ? error.message : String(error)}`,
    kind,
  });
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

/** A positive finite `width / height`, or 0 when either side is unusable. */
function ratioOrZero(width: number | null, height: number | null): number {
  if (width === null || height === null || width <= 0 || height <= 0) return 0;
  const ratio = width / height;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
}

/**
 * Read one property as a number, degrading to `null` on ANY failure.
 *
 * WHY not `getProperty`'s throw-through contract: the only consumer is the PiP
 * window-resize path, which must never break playback. A failing read therefore
 * falls through to the next fallback step (see `getVideoAspect`) and is reported
 * with context instead of being rethrown.
 */
async function readNumberProperty(
  kind: string,
  name: string,
): Promise<number | null> {
  try {
    return asNumber(await getProperty(name));
  } catch (error) {
    logAspectFailure(kind, error);
    return null;
  }
}

/** Positive display aspect ratio (`width / height`); 0 = unknown. */
export async function getVideoAspect(): Promise<number> {
  // The order is a correctness ladder, not a preference. `video-params/aspect`
  // is the ratio mpv actually draws, with anamorphic/PAR correction already
  // folded in, so a window sized to it shows no letterbox. `dwidth`/`dheight`
  // are the post-scale display size (same idea, but absent on some hardware
  // paths), and raw `width`/`height` are the DECODED size — for an anamorphic
  // source those differ from what is on screen, which is why they come last.
  const reported = await readNumberProperty(
    "video-params/aspect",
    MPV_CONTROL_PROPERTIES.videoParamsAspect,
  );
  if (reported !== null && Number.isFinite(reported) && reported > 0) {
    return reported;
  }

  const [dwidth, dheight] = await Promise.all([
    readNumberProperty("dwidth", MPV_CONTROL_PROPERTIES.dwidth),
    readNumberProperty("dheight", MPV_CONTROL_PROPERTIES.dheight),
  ]);
  const displayRatio = ratioOrZero(dwidth, dheight);
  if (displayRatio > 0) return displayRatio;

  const [width, height] = await Promise.all([
    readNumberProperty("width", MPV_CONTROL_PROPERTIES.width),
    readNumberProperty("height", MPV_CONTROL_PROPERTIES.height),
  ]);
  return ratioOrZero(width, height);
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
