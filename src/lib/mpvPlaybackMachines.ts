/**
 * Playback state machines extracted from mpvProtocol.ts (structural split):
 * the display-delay BufferingTracker, the TimePosWatchdog push-gap backfill,
 * and the pinned-playhead StallReconciler. Timers arm through TimerRegistry;
 * engine state arrives via constructor callbacks. The Tauri/mpv wire contract
 * and the shared tuning constants stay in mpvProtocol.ts.
 */

export { BufferingTracker } from "./mpvPlaybackMachines/BufferingTracker";
export { TimePosWatchdog } from "./mpvPlaybackMachines/TimePosWatchdog";
export type {
  StallTruth,
  StallReconcilerCallbacks,
} from "./mpvPlaybackMachines/StallReconciler";
export { StallReconciler } from "./mpvPlaybackMachines/StallReconciler";
