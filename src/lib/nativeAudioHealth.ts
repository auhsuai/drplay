import type { NativeAudioState } from "./nativeAudioTypes";

/** Injected engine-side capabilities — the health unit owns the
 *  idempotency/retry logic only; the engine keeps the real IPC (tauri
 *  invoke + plugin listener registration live in the engine, not here). */
export interface HealthDeps {
  /** The engine's two bounded init invokes: initialize + listener register
   *  (verbatim runInitCommands). */
  initOnceCommand: () => Promise<void>;
  /** Read-only get_state probe (the raw IPC lives engine-side) — the raw
   *  snapshot comes back here for the undefined-skip in pullCurrentState. */
  probeState: () => Promise<NativeAudioState | undefined>;
  /** Fan the authoritative pulled state through the live event path. */
  onState: (state: NativeAudioState) => void;
  /** Engine's classified warn log (engine.report). */
  report: (context: string, e: unknown) => void;
}

/** Bridge lifecycle + long-suspend recovery extracted from NativeAudioEngine —
 *  owns the cached init promise, the once-only visibilitychange listener and
 *  the resume health-check (tauri#15671 family): after the activity survives
 *  a long device sleep, the plugin event channel or the invoke bridge can
 *  be dead while the UI keeps rendering the cached lastState — progress
 *  freezes silently. On each visible transition, probe the bridge with the
 *  read-only get_state command; on failure reset the cached init, re-run
 *  initOnce() (re-subscribes the state listener) and re-pull the
 *  authoritative state through the normal onNativeState path. */
export class NativeBridgeHealth {
  private deps: HealthDeps;
  private initPromise: Promise<void> | undefined;
  // The visibilitychange listener is attached once per health unit (on first
  // initOnce) and never re-attached on re-init, so a recovered bridge never
  // accumulates duplicate listeners.
  // resumeCheckInFlight guards two overlapping visible transitions.
  private resumeCheckListenerAttached = false;
  private resumeCheckInFlight = false;

  constructor(deps: HealthDeps) {
    this.deps = deps;
  }

  /** Initialize the plugin once. Safe to call repeatedly — the underlying
   *  command runs exactly once; a failure resets the cache so a later call
   *  (e.g. after permission grant) can re-init. */
  initOnce(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.runFirstInit().catch((e: unknown) => {
        // Reset so a later retry (e.g. after permission grant) can re-init.
        this.initPromise = undefined;
        throw e;
      });
    }
    return this.initPromise;
  }

  private async runFirstInit(): Promise<void> {
    // The resume health-check listener rides on the first init so it
    // exists even when this first initialize() fails — the probe's
    // re-init path is then the only recovery.
    this.attachResumeHealthCheck();
    await this.deps.initOnceCommand();
  }

  /** Pull the authoritative player state once and feed it through the same
   *  onNativeState path as live events, so store + UI re-sync after a
   *  suspend: a still-playing foreground service resumes ticking into the
   *  fresh listener, and play/pause edges fire exactly as they would for
   *  live events (identical-state pushes are no-ops by design). */
  async pullCurrentState(): Promise<void> {
    const state = await this.deps.probeState();
    if (state) this.deps.onState(state);
  }

  private attachResumeHealthCheck(): void {
    if (this.resumeCheckListenerAttached) return;
    this.resumeCheckListenerAttached = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      void this.runResumeHealthCheck();
    });
  }

  private async runResumeHealthCheck(): Promise<void> {
    if (this.resumeCheckInFlight) return;
    this.resumeCheckInFlight = true;
    try {
      await this.pullCurrentState();
    } catch (e: unknown) {
      this.deps.report("resume health-check failed, re-initializing", e);
      // Drop the cached init (possibly a dead listener registration) and
      // rebuild it; initOnce re-subscribes the plugin listener.
      this.initPromise = undefined;
      try {
        await this.initOnce();
        await this.pullCurrentState();
      } catch (reinitError: unknown) {
        // Still dead: everything stays reset so the NEXT visible transition
        // retries once more (bounded — no polling, no infinite loop).
        this.deps.report("resume re-init failed", reinitError);
      }
    } finally {
      this.resumeCheckInFlight = false;
    }
  }
}
