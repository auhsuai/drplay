import { invoke } from "@tauri-apps/api/core";
import { describeError, MPV_COMMANDS, TAURI_COMMANDS } from "../mpvProtocol";

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
 *
 * This is the ONLY module of the package that touches the Tauri invoke
 * bridge; every other module goes through getProperty / invokeCommand /
 * setProperty here.
 */

export const MPV_CONTROL_PROPERTIES = {
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
  videoParamsAspect: "video-params/aspect",
  dwidth: "dwidth",
  dheight: "dheight",
  containerFps: "container-fps",
  pixelFormat: "video-params/pixelformat",
  audioCodecName: "audio-codec-name",
  hwdecCurrent: "hwdec-current",
  currentVo: "current-vo",
  videoBitrate: "video-bitrate",
  audioBitrate: "audio-bitrate",
} as const;

export const MPV_CONTROL_COMMANDS = {
  add: "add",
  subAdd: "sub-add",
  screenshotToFile: "screenshot-to-file",
  /** mpv flag for `sub-add`: select the newly added track. */
  subAddSelectFlag: "select",
} as const;

export function wrapError(operation: string, cause: unknown): Error {
  return new Error(`mpvControl ${operation} failed: ${describeError(cause)}`);
}

export async function getProperty(name: string): Promise<unknown> {
  try {
    return await invoke(TAURI_COMMANDS.mpvGetProperty, { prop: name });
  } catch (e: unknown) {
    throw wrapError(`get ${name}`, e);
  }
}

export async function invokeCommand(cmd: string[]): Promise<void> {
  try {
    await invoke(TAURI_COMMANDS.mpvCommand, { cmd });
  } catch (e: unknown) {
    throw wrapError(`command ${cmd[0] ?? "unknown"}`, e);
  }
}

export async function setProperty(name: string, value: string): Promise<void> {
  await invokeCommand([MPV_COMMANDS.setProperty, name, value]);
}
