import { asNumber, asString } from "../mpvProtocol";
import { getProperty, MPV_CONTROL_PROPERTIES } from "./ipc";
import { getTrackList, type MpvTrack } from "./tracks";

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
