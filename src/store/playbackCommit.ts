import { usePlayerStore } from "./playerStore";

/**
 * Named writers for the isPlaying store flag (audit §15 R1.1). Before this
 * module, isPlaying was written from ~10 call sites across 6 files with four
 * distinct meanings (intent / engine-truth / policy / teardown) — no single
 * place to audit "who flips playback state". Every non-engine writer now
 * routes through commitIsPlaying so the source of each write is nameable.
 */
export type PlaybackCommitSource = "intent" | "engine" | "policy" | "teardown";

let lastCommitSource: PlaybackCommitSource | null = null;

/**
 * Single named choke point for isPlaying writes.
 *
 * Behavior is IDENTICAL to calling
 * `usePlayerStore.getState().setIsPlaying(playing)` directly: same value,
 * same timing, no extra store round-trip (getState, not a hook selector —
 * existing tests that `vi.mock` playerStore keep working unchanged).
 *
 * Why getState() instead of a selector: this module is called from event
 * handlers, effects and non-React code (utils), where subscribing is not
 * possible; the setter itself is a stable zustand action.
 *
 * The `source` is RECORDED for tests/observability only — it does not
 * change semantics, branching or ordering. Engine writes
 * (src/lib/mpvAudio.ts) stay raw until R3.2.
 */
export function commitIsPlaying(
  source: PlaybackCommitSource,
  playing: boolean,
): void {
  lastCommitSource = source;
  usePlayerStore.getState().setIsPlaying(playing);
}

/** Source of the most recent commit (null before any commit). Test/observability aid. */
export function getLastPlaybackCommitSource(): PlaybackCommitSource | null {
  return lastCommitSource;
}

/** Test-only reset of the recorded source (module state is process-global). */
export function __resetPlaybackCommitSourceForTests(): void {
  lastCommitSource = null;
}
