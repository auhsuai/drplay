import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ensureVideoHostAcquired } from "../videoHost";
import {
  dispatchMpvEvent,
  dispatchPropertyEvent,
  isRecord,
  LOADFILE_RESTART_TIMEOUT_MS,
  PROXY_START_TIMEOUT_MS,
  TAURI_COMMANDS,
  TAURI_EVENTS,
  withStallQueryTimeout,
  type MpvEventCallbacks,
} from "../mpvProtocol";
import { detachListeners } from "./eventHub";

/** Everything the session needs from the controller — explicit, one-way. */
export interface EngineSessionDeps {
  events: MpvEventCallbacks;
  noteProxyError(payload: unknown): void;
  applyVolume(): void;
  getUnlistenFns(): UnlistenFn[];
  setUnlistenFns(fns: UnlistenFn[]): void;
}

/** Lifecycle/connection session extracted from MpvAudioController (Chặng B):
 *  spawn dedupe, lifecycle epoch, per-connection identity (Fix B3/R2.2),
 *  proxy port and the load-deadline sidecar swap. Playback state machines
 *  stay in the controller. */
export class EngineSession {
  private started = false;
  // Why: release() must invalidate every async continuation still in flight
  // (listener attach / spawn / loadfile) so none resurrects engine state.
  private lifecycleEpoch = 0;
  // Why (Fix B3): stale-event identity across a loadfile — Rust tags every
  // mpv-property/mpv-event with the load-epoch of the sidecar connection it
  // was dispatched under, and every `mpv_command` reply carries the current
  // tag (`load_epoch`). Events below the latest loadfile reply's epoch belong
  // to the previous track and must not drive the new one.
  private engineEpochValue = 0;
  // Why (R2.2): the epoch counter is per connection — a fresh sidecar restarts
  // it at 0 (Fix B3), so an in-flight event of the REPLACED connection can sit
  // above the new base and pass the epoch filter (B1), and release() resetting
  // the base to 0 lets late events drive a torn-down engine (RC-1). Rust mints
  // a process-wide monotonic `conn` per connection and tags every event with
  // it; the engine adopts it from the `mpv_spawn` reply and drops every event
  // of another connection. `null` = no live connection (pre-spawn / released).
  private engineConnValue: number | null = null;
  /** Shared in-flight spawn attempt — concurrent playTrack calls join it. */
  private startPromise: Promise<boolean> | null = null;
  /** Shared in-flight sidecar swap of a load-deadline restart (F8-1): every
   *  new load request parks on it (ensureStarted) instead of issuing a
   *  loadfile into the dying process. */
  private restartInFlight: Promise<void> | null = null;
  private proxyPort: number | null = null;
  private readonly deps: EngineSessionDeps;

  constructor(deps: EngineSessionDeps) {
    this.deps = deps;
  }

  public get isStarted(): boolean {
    return this.started;
  }

  public get epoch(): number {
    return this.lifecycleEpoch;
  }

  public get port(): number | null {
    return this.proxyPort;
  }

  /** Read-only state for the controller's private observability bridge
   *  (guard tests pin the epoch/connection resets). */
  public get engineEpoch(): number {
    return this.engineEpochValue;
  }

  public get engineConn(): number | null {
    return this.engineConnValue;
  }

  public trackRestart(swap: Promise<void>): void {
    this.restartInFlight = swap;
  }

  public clearRestart(swap: Promise<void>): void {
    if (this.restartInFlight === swap) this.restartInFlight = null;
  }

  /** release() part 1 — runs BEFORE listener detach: bump FIRST so every
   *  in-flight continuation observes the teardown at its next await boundary. */
  public beginRelease(): void {
    this.lifecycleEpoch += 1;
    this.startPromise = null;
    this.restartInFlight = null;
  }

  /** release() part 2 — runs AFTER listener detach (same teardown order). */
  public finishRelease(): void {
    this.started = false;
    // Fix B3: a torn-down sidecar owns no epoch — the next spawn starts fresh.
    this.engineEpochValue = 0;
    // R2.2: and no connection — late events of the torn-down sidecar must not
    // revive timers/state (RC-1).
    this.engineConnValue = null;
    this.proxyPort = null;
  }

  /** onEngineClosed: mpv died without an end-file — reset lifecycle so the
   *  next playTrack respawns via mpv_spawn. */
  public markEngineClosed(): void {
    this.started = false;
    // R2.2: the connection is gone — any further event tagged with its id is
    // late by definition and must not drive the engine.
    this.engineConnValue = null;
  }

  public async ensureStarted(epoch: number): Promise<boolean> {
    // Why (F8-1): a load-deadline restart swaps the sidecar internally — the
    // old mpv is going away and its replacement is not up yet, so issuing a
    // loadfile now would race a dying process (and the restart's own reload
    // would then clobber the newcomer). Park the request until the swap
    // settles; `started` deliberately stays true across it. A failed swap
    // resolves the wait and lets the request surface its own bounded failure.
    if (this.restartInFlight) {
      try {
        await this.restartInFlight;
      } catch {
        // onLoadDeadline owns the swap's single failure surface (F8-6 dedupe).
      }
      // Release during the wait: this request belongs to a torn-down
      // lifecycle — it must not boot a fresh engine (no resurrection).
      if (this.isStale(epoch)) return false;
    }
    if (this.started) return true;
    // Why: dedupe concurrent playTrack calls — one spawn attempt wins, the
    // rest join it instead of attaching a second listener set.
    if (this.startPromise) return this.startPromise;
    const attempt = this.startEngine();
    this.startPromise = attempt;
    try {
      return await attempt;
    } finally {
      // Identity check: only this exact attempt owns the memo — a release or
      // a newer attempt must never be clobbered here.
      if (this.startPromise === attempt) this.startPromise = null;
    }
  }

  /** Spawn attempt body. Returns false when release() made it stale mid-flight. */
  private async startEngine(): Promise<boolean> {
    const epoch = this.lifecycleEpoch;
    const attached: UnlistenFn[] = [];
    try {
      attached.push(
        await listen(TAURI_EVENTS.property, (event) => {
          if (this.isStaleEnginePayload(event.payload)) return;
          dispatchPropertyEvent(event.payload, this.deps.events);
        }),
      );
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      attached.push(
        await listen(TAURI_EVENTS.event, (event) => {
          if (this.isStaleEnginePayload(event.payload)) return;
          dispatchMpvEvent(event.payload, this.deps.events);
        }),
      );
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      attached.push(
        await listen(TAURI_EVENTS.streamProxyError, (event) => {
          this.deps.noteProxyError(event.payload);
        }),
      );
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      // ORDERING CONTRACT (Slice 2): mpv reads `--wid` ONCE, at spawn, so the
      // native video host must exist BEFORE this call — otherwise video opens
      // in mpv's own top-level window for the whole engine session. The
      // acquire resolves 0 (never throws) when the host is unavailable, which
      // degrades to exactly that pre-Slice-1 behavior instead of failing the
      // spawn. App also acquires on startup (src/App.tsx), so by the time a
      // first play reaches here the handle is usually already memoized.
      await ensureVideoHostAcquired();
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      const reply = await invoke(TAURI_COMMANDS.mpvSpawn);
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      // Fix B3: a fresh sidecar's load epoch restarts at 0 (the Rust counter
      // is per connection) — adopting that base keeps its events from being
      // dropped below a previous track's epoch after a crash respawn.
      this.engineEpochValue = 0;
      // R2.2: adopt the new connection's identity so its events — and only
      // its — are accepted from here on.
      this.noteSpawnReply(reply);
    } catch (e: unknown) {
      detachListeners(attached);
      throw e;
    }
    this.deps.setUnlistenFns(attached);
    this.started = true;
    // Fresh mpv starts at volume 100 — re-apply the stored (or muted) volume.
    this.deps.applyVolume();
    return true;
  }

  /** True when release() bumped the epoch past the captured one. */
  public isStale(epoch: number): boolean {
    return epoch !== this.lifecycleEpoch;
  }

  /** A stale start owns handles release() never saw: drop them, touch no state. */
  private disposeStaleStart(attached: UnlistenFn[]): boolean {
    detachListeners(attached);
    return false;
  }

  public async ensureProxyPort(): Promise<number> {
    if (this.proxyPort === null) {
      // Why (D8): a hung stream_proxy_start reply must not hold the playback
      // attempt open forever. The timeout throws before the assignment, so
      // proxyPort stays null — the next attempt re-invokes (Rust side is
      // idempotent) and a late reply can never write a stale port.
      this.proxyPort = await withStallQueryTimeout(
        invoke<number>(TAURI_COMMANDS.streamProxyStart),
        PROXY_START_TIMEOUT_MS,
      );
    }
    return this.proxyPort;
  }

  /** True when a tagged event payload cannot drive THIS engine (Fix B3 +
   *  R2.2): its connection is not the live one, or it predates the latest
   *  loadfile reply. Robust by contract: a payload missing the tag passes, so
   *  an older sender stays compatible. */
  private isStaleEnginePayload(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    const conn = payload["conn"];
    if (
      typeof conn === "number" &&
      (this.engineConnValue === null || conn !== this.engineConnValue)
    ) {
      // A tagged event of a replaced (or absent) connection: its epoch base
      // was reset by the respawn/release, so it must never drive this engine.
      return true;
    }
    const epoch = payload["epoch"];
    return typeof epoch === "number" && epoch < this.engineEpochValue;
  }

  /** Adopt the connection identity of an `mpv_spawn` reply (R2.2). Idempotent
   *  for the spawn no-op path (running sidecar answers with its own id); a
   *  malformed/legacy reply without a numeric `conn` is a no-op. */
  private noteSpawnReply(reply: unknown): void {
    if (!isRecord(reply)) return;
    const conn = reply["conn"];
    if (typeof conn === "number") this.engineConnValue = conn;
  }

  /** Adopt the load epoch of a `loadfile` reply (Rust returns
   *  `{ data, load_epoch }` for every `mpv_command`). Monotonic — a lower tag
   *  never lowers the base; a missing/malformed tag is a no-op. */
  public noteLoadEpoch(reply: unknown): void {
    if (!isRecord(reply)) return;
    const epoch = reply["load_epoch"];
    if (typeof epoch !== "number") return;
    this.engineEpochValue = Math.max(this.engineEpochValue, epoch);
  }

  /** One load-deadline sidecar swap (F8-1): shutdown the wedged mpv, spawn
   *  the replacement, then re-base the per-connection state (Fix B3 epoch,
   *  facade volume). Shared through `restartInFlight` so concurrent load
   *  requests wait it out instead of racing a dying process. Each IPC call is
   *  bounded; a release mid-swap aborts at the next await boundary. */
  public async swapSidecar(epoch: number): Promise<void> {
    await withStallQueryTimeout(
      invoke(TAURI_COMMANDS.mpvShutdown),
      LOADFILE_RESTART_TIMEOUT_MS,
    );
    if (this.isStale(epoch)) return;
    // Same `--wid` ordering contract as startEngine: the replacement sidecar
    // reads the flag at ITS spawn too. Memoized, so this is a no-op resolve
    // for every restart after the first.
    await ensureVideoHostAcquired();
    if (this.isStale(epoch)) return;
    const reply = await withStallQueryTimeout(
      invoke(TAURI_COMMANDS.mpvSpawn),
      LOADFILE_RESTART_TIMEOUT_MS,
    );
    if (this.isStale(epoch)) return;
    // Fix B3: the replacement sidecar's epoch counter restarts at 0 — a stale
    // epoch base would drop every event of whatever loads next.
    this.engineEpochValue = 0;
    // R2.2: the replacement is a new connection — the old id's events (its
    // epoch base reset above) must never pass again.
    this.noteSpawnReply(reply);
    // A fresh mpv starts at volume 100 — re-apply the facade volume.
    this.deps.applyVolume();
  }
}
