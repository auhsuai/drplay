/** Native-queue transport selection extracted from NativeAudioEngine —
 *  decides between the whole-playlist set_queue push (native ExoPlayer
 *  auto-advance) and the single-item set_source path, and shapes the
 *  set_queue payload. Pure functions: no engine state, no store access. */
import type { PlayMode, Track } from "../types";
import { buildDriveStreamUrl } from "./nativeAudioInvoke";

export interface QueueTransportSelection {
  useNativeQueue: boolean;
  // The playlist mirrored to the plugin: the whole store queue on the native
  // path, a single-item list otherwise. The engine stores this into its
  // queueMirror (reset by release()).
  queueMirror: Track[];
}

export function selectQueueTransport(
  track: Track,
  playbackQueue: Track[],
): QueueTransportSelection {
  // Native queue push: when the track belongs to a multi-item store queue,
  // load the WHOLE playlist so ExoPlayer auto-advances natively (a
  // backgrounded WebView cannot run the JS advance — Bug 3). A single-item
  // queue keeps the plain setSource path. seek/play act on the startIndex
  // item.
  const queueIdx = playbackQueue.findIndex((t) => t.id === track.id);
  const useNativeQueue = playbackQueue.length > 1 && queueIdx !== -1;
  return {
    useNativeQueue,
    queueMirror: useNativeQueue ? playbackQueue : [track],
  };
}

/** The payload shape matches invokeStateful's Record<string, unknown> slot;
 *  the index signature keeps the interface assignable to it. */
export interface SetQueuePayload extends Record<string, unknown> {
  items: Array<{ src: string; id: string; title: string; artist: string }>;
  startIndex: number;
  headers?: { Authorization: string } | undefined;
  repeatMode: PlayMode;
}

export function buildSetQueuePayload(
  playbackQueue: Track[],
  queueIdx: number,
  headers: { Authorization: string } | undefined,
  repeatMode: PlayMode,
): SetQueuePayload {
  return {
    items: playbackQueue.map((t) => ({
      src: buildDriveStreamUrl(t.id),
      id: t.id,
      title: t.title,
      artist: t.artist,
    })),
    startIndex: queueIdx,
    headers,
    repeatMode,
  };
}
