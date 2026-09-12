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
  onFire: () => void;
  onDrop: () => void;
}

/**
 * Shared "settle-once + cleanup" skeleton for deferred work in
 * usePlayerTrackPlayback: waits for first-audio (or the optional fallback
 * timer), fires at most once, drops on error/abort, and frees every listener
 * + timer on all exits. Never fires/drops if none of those happen.
 */
export function onceAfterFirstAudio(
  audio: DeferAudioSource,
  signal: AbortSignal,
  { fallbackMs, onFire, onDrop }: DeferOnceOptions,
): void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubFirstAudio: (() => void) | undefined;
  let unsubError: (() => void) | undefined;

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
  const fire = (): void => {
    if (settled || signal.aborted) return;
    settled = true;
    cleanup();
    onFire();
  };
  function drop(): void {
    if (settled) return;
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
