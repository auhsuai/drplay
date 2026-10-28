/**
 * Pure derivations lifted out of `MpvAudioController` (plan 02, CP1). Every
 * function here is a function OF ITS ARGUMENTS: no field reads, no hidden
 * state, no side effects — the controller keeps the field ownership and only
 * calls in. Keeping them pure is what makes them safe to move; anything that
 * needs live engine state stays a controller method (see
 * `deadlineSuperseded`, deliberately NOT extracted: it must read
 * `playbackFinished` / `currentTrackId` / `loadRequestSeq` afresh on every
 * call, because a snapshot taken before the await re-introduces F8-1).
 */
import type { AudioEventIdentity, AudioEventMap } from "../audioNativeEvents";
import {
  asBoolean,
  asNumber,
  extractCacheRanges,
  maxRangeEnd,
  SEEK_ACK_TOLERANCE_SECS,
  VOLUME_SCALE,
} from "../mpvProtocol";
import type { StallTruth } from "../mpvPlaybackMachines";
import type { ProxyErrorRecord } from "./types";

/** Identity attached to every emitted event (R2.1). `trackIdOverride`
 *  attributes an event to a load target the engine has not begun yet (a
 *  failed new load); such an event carries no attempt — no engine load
 *  identity exists for it. A missing current track yields `{}` so the event
 *  stays untagged and consumers keep legacy behavior. */
export function buildEventIdentity(
  currentTrackId: string | null,
  attemptSeq: number,
  trackIdOverride?: string,
): AudioEventIdentity {
  const trackId = trackIdOverride ?? currentTrackId;
  if (trackId === null) return {};
  return trackId === currentTrackId
    ? { trackId, attempt: attemptSeq }
    : { trackId };
}

/** Facade volume/mute -> the integer mpv's `volume` property takes. */
export function toMpvVolume(volume: number, muted: boolean): number {
  const mpvVolume = muted ? 0 : volume * VOLUME_SCALE;
  return Math.round(mpvVolume);
}

/** The proxy status usable for THIS stream only — a stale event (other
 *  fileId, previous stream) must never steer end-file classification. */
export function proxyStatusForStream(
  error: ProxyErrorRecord | null,
  currentTrackId: string | null,
): number | null {
  if (error === null || error.fileId !== currentTrackId) return null;
  return error.status;
}

/** Seek ack (S1): a report within tolerance of the seek target IS the ack —
 *  anything farther is a stale pre-seek value and must be dropped. */
export function isSeekAckReport(time: number, target: number): boolean {
  return Math.abs(time - target) <= SEEK_ACK_TOLERANCE_SECS;
}

/** Map one reconcile round's raw property replies onto `StallTruth`. */
export function parseStallTruth(
  timePosRaw: unknown,
  bufferingRaw: unknown,
  cacheRaw: unknown,
): StallTruth {
  return {
    timePos: asNumber(timePosRaw),
    buffering: asBoolean(bufferingRaw),
    cacheEnd: maxRangeEnd(extractCacheRanges(cacheRaw)),
  };
}

/** Tag every payload with the engine identity (R2.1). Spread keeps the
 *  event's own fields authoritative and tolerates `undefined` payloads. */
export function tagPayload<K extends keyof AudioEventMap>(
  identity: AudioEventIdentity,
  payload: AudioEventMap[K],
): AudioEventMap[K] {
  return {
    ...identity,
    ...(payload as object | undefined),
  } as AudioEventMap[K];
}
