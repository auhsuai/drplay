// Session restore position is a ONE-SHOT resume hint (F7-6/F8-8). It is armed
// once when usePlayerSession commits the restored track and consumed by the
// FIRST play of that exact track (PlayerBar's play bridge). It deliberately
// lives OUTSIDE the Track object: the restored track survives in both queues
// (and in the persisted session), so an engine start time read off the object
// would seek every later replay-after-EOF / prev-next return / retry back to
// the stale position. Track.restoreTime itself stays only for SeekBar's
// initial fill and is never engine input.
let pending: { trackId: string; time: number } | null = null;

/** Arm the one-shot resume hint for the track a session restore just committed. */
export function armRestoreResume(trackId: string, time: number): void {
  pending = { trackId, time };
}

/**
 * Take the armed resume position for `trackId`, exactly once. Playing any
 * other track leaves the hint armed (the restored track's first play is still
 * pending); every later play of the same track gets undefined — start at 0 /
 * engine resume, never the stale restore position.
 */
export function consumeRestoreResume(trackId: string): number | undefined {
  if (pending === null || pending.trackId !== trackId) return undefined;
  const { time } = pending;
  pending = null;
  return time;
}

/** Drop the armed hint (teardown, tests). */
export function clearRestoreResume(): void {
  pending = null;
}
