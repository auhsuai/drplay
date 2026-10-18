/**
 * mpvControl — property/command facade for player-UI features (track menus,
 * video adjustments, screenshots, media info). Same IPC tier as mpvAudio:
 * every call goes through the existing `mpv_command` / `mpv_get_property`
 * Tauri commands and the shared protocol constants (mpvProtocol.ts). This
 * module never touches the playback engine state — it is a request/response
 * surface only.
 *
 * The implementation lives in `mpvControl/`; this file only re-exports the
 * public surface so every existing import path keeps working.
 */

export {
  ASPECT_AUTO,
  ASPECT_NO,
  aspectCycleValue,
  cropRectFor,
  deinterlaceCycle,
  nextTrackId,
  SPEED_NORMAL,
  speedStep,
} from "./mpvControl/calculations";
export { getMediaInfo, type MediaInfoSnapshot } from "./mpvControl/mediaInfo";
export {
  addSubtitleFile,
  getAudioDevice,
  getAudioDevices,
  getChapters,
  getCurrentChapter,
  getSecondarySubtitleId,
  getSubtitleVisibility,
  getTrackList,
  setAudioDevice,
  setAudioTrack,
  setChapter,
  setSecondarySubtitle,
  setSubtitleTrack,
  setVideoTrack,
  toggleSubtitleVisibility,
  type MpvAudioDevice,
  type MpvChapter,
  type MpvTrack,
  type MpvTrackType,
} from "./mpvControl/tracks";
export {
  addAudioDelay,
  addSubDelay,
  addVideoZoom,
  buildScreenshotName,
  clearAbLoop,
  getAbLoop,
  getAspectOverride,
  getAudioDelay,
  getCrop,
  getDeinterlace,
  getSpeed,
  getSubDelay,
  getVideoDimensions,
  getVideoZoom,
  resetAudioDelay,
  resetSubDelay,
  resetVideoView,
  setAbLoopA,
  setAbLoopB,
  setAspectOverride,
  setCrop,
  setDeinterlace,
  setSpeed,
  takeScreenshot,
  type AbLoopPoints,
} from "./mpvControl/videoControls";
