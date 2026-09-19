import type { AudioEventHandler } from "../../lib/audioNativeEvents";

/** Minimal audio surface deferOnce needs (AudioController satisfies it). */
export interface DeferAudioSource {
  on<K extends "first-audio" | "error">(
    event: K,
    handler: AudioEventHandler<K>,
  ): () => void;
}

export interface DeferOnceOptions {
  /** When set, a timer fires the defer even without first-audio. Omitted =
   *  first-audio only (stuck session simply never fires). */
  fallbackMs?: number;
  /** Engine track this defer belongs to (R2.1). When set, a tagged
   *  first-audio/error of ANOTHER track is ignored (the defer keeps waiting
   *  for its own track); untagged events keep legacy behavior. */
  trackId?: string;
  onFire: () => void;
  onDrop: () => void;
}

/**
 * Shared "settle-once + cleanup" skeleton for deferred work in
 * usePlayerTrackPlayback: waits for first-audio (or the optional fallback
 * timer), fires at most once, drops on error/abort, and frees every listener
 * + timer on all exits. Never fires/drops if none of those happen. An
 * already-aborted signal is a silent no-op (nothing is registered): abort
 * events never replay, and any UI teardown belongs to the operation that
 * replaced this one, not to onDrop.
 */
export function onceAfterFirstAudio(
  audio: DeferAudioSource,
  signal: AbortSignal,
  { fallbackMs, trackId, onFire, onDrop }: DeferOnceOptions,
): void {
  // Guard before subscribing: a listener added to an already-aborted signal
  // never fires, so the unsubs/timer would leak forever. Silent no-op on
  // purpose — onDrop must NOT run here (its consumer shares a busy flag with
  // the replacing operation, whose spinner it would wrongly clear).
  if (signal.aborted) return;

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubFirstAudio: (() => void) | undefined;
  let unsubError: (() => void) | undefined;

  // R2.1: an event may settle this defer only when it is untagged (older
  // sender / no active track) or tagged with the registered track. A stale
  // track's first-audio/error must neither fire nor drop the new track's
  // deferred work.
  const maySettle = (payload: unknown): boolean => {
    if (trackId === undefined) return true;
    const eventTrackId = (payload as { trackId?: string } | undefined)?.trackId;
    return eventTrackId === undefined || eventTrackId === trackId;
  };

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    unsubFirstAudio?.();
    unsubFirstAudio = undefined;
    unsubError?.();
    unsubError = undefined;
    signal.removeEventListener("abort", drop);
  };
  const fire = (payload?: unknown): void => {
    if (settled || signal.aborted) return;
    if (!maySettle(payload)) return;
    settled = true;
    cleanup();
    onFire();
  };
  function drop(payload?: unknown): void {
    if (settled) return;
    if (!maySettle(payload)) return;
    settled = true;
    cleanup();
    onDrop();
  }

  unsubFirstAudio = audio.on("first-audio", fire);
  unsubError = audio.on("error", drop);
  signal.addEventListener("abort", drop, { once: true });
  if (fallbackMs !== undefined) {
    timer = setTimeout(fire, fallbackMs);
  }
}
