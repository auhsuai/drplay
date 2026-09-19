import { AudioController } from "../lib/AudioController";
import { usePlayerStore } from "../store/playerStore";

// Fix I — auto-advance storm guard. When EVERY track fails with format_error
// (unrecoverable decode / SRC_NOT_SUPPORTED — e.g. Drive locked or quota hit),
// AudioController emits error → ended → auto-next per track, silently burning
// through the whole queue (the per-track toast is cleared by the next track
// change before it can be read). After STORM_ERRORS format_errors inside
// STORM_WINDOW_MS the guard stops auto-advance, pauses playback and shows a
// clear message instead. A blocked guard re-arms after STORM_COOLDOWN_MS
// without new errors; any successful play or manual transport action resets
// it immediately.
//
// The guard lives HERE (module scope, not component refs) because the manual
// retry must reset the SAME guard from two surfaces: the PlayerBar transport
// row and the full-screen NowPlaying controls (P2-12-6). PlayerBar is the only
// subscriber that drives the guard from audio events.
export const STORM_ERRORS = 3;
export const STORM_WINDOW_MS = 15_000;
export const STORM_COOLDOWN_MS = 30_000;

interface AdvanceGuard {
  formatErrorCount: number;
  windowStart: number;
  blockedAt: number | null;
}

const advanceGuard: AdvanceGuard = {
  formatErrorCount: 0,
  windowStart: 0,
  blockedAt: null,
};

/** Clear the storm counter/window/block — a fresh start (manual action, play). */
export function resetAdvanceGuard(): void {
  advanceGuard.formatErrorCount = 0;
  advanceGuard.windowStart = 0;
  advanceGuard.blockedAt = null;
  // F8-3: the storm banner is the visible face of a blocked guard — dropping
  // the block (manual action, session stop, cooldown over) must drop its stale
  // banner too, or it orphans on screen claiming a failure that no longer
  // blocks anything. Only the storm code is touched: every other error keeps
  // its own clear rules (play event / track change).
  const { errorInfo, setErrorInfo } = usePlayerStore.getState();
  if (errorInfo?.code === "advance_stopped") setErrorInfo(null);
}

/**
 * Record one format_error against the sliding storm window.
 * @returns true when the storm banner must be shown (guard blocked): a blocked
 * guard absorbs further errors and keeps its banner up until STORM_COOLDOWN_MS
 * passes without a new error, at which point it re-arms from scratch.
 */
export function noteFormatError(now: number): boolean {
  if (advanceGuard.blockedAt !== null) {
    if (now - advanceGuard.blockedAt <= STORM_COOLDOWN_MS) return true;
    resetAdvanceGuard();
  }
  if (now - advanceGuard.windowStart > STORM_WINDOW_MS) {
    advanceGuard.formatErrorCount = 1;
    advanceGuard.windowStart = now;
  } else {
    advanceGuard.formatErrorCount += 1;
  }
  if (advanceGuard.formatErrorCount >= STORM_ERRORS) {
    advanceGuard.blockedAt = now;
    return true;
  }
  return false;
}

/**
 * Whether the `ended` auto-advance may run right now. false = a blocked guard
 * within its cooldown (the caller must stop playback instead of advancing); an
 * expired block resets the guard and allows the advance again.
 */
export function guardAllowsAutoAdvance(now: number): boolean {
  if (advanceGuard.blockedAt !== null) {
    if (now - advanceGuard.blockedAt <= STORM_COOLDOWN_MS) return false;
    resetAdvanceGuard();
  }
  return true;
}

/**
 * Manual "retry current track" (center transport button). Retrying is a
 * user-initiated transport action, so it resets the storm guard and replays
 * the current track. It deliberately passes NO start time: the session restore
 * position is a one-shot hint owned by the first play after a restore
 * (F7-6/F8-8), so a retry must never seek back to it. The engine then keeps
 * mpv's own position for a same-track mid-playback retry, and restarts from 0
 * after a terminal failure. Shared by PlayerBar's TransportControls and the
 * full-screen NowPlayingControls so both surfaces run the exact same retry
 * (P2-12-6 parity), instead of one of them growing a second implementation.
 */
export function retryCurrentTrack(): void {
  resetAdvanceGuard();
  const track = usePlayerStore.getState().currentTrack;
  if (track) {
    void AudioController.getInstance().playTrack(track);
  }
}
