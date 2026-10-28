import { describeError, MPV_COMMANDS, MPV_PROPERTY_ARGS } from "../mpvProtocol";
import { toMpvVolume } from "./derive";
import { logWarn } from "./log";

/** Everything the volume facade needs from the controller — two calls, no
 *  field access: the engine lifecycle stays owned by EngineSession. */
export interface VolumePort {
  /** Has the sidecar been spawned (`session.isStarted`)? */
  isEngineStarted(): boolean;
  /** The engine's single IPC path. */
  sendCommand(cmd: string[]): Promise<unknown>;
}

/** Facade volume/mute state extracted from MpvAudioController (plan 02, CP2).
 *  Owns only `volume`/`muted`; it never reads playback state and never arms a
 *  timer — the controller delegates its four public accessors here. */
export class VolumeController {
  private volume = 1;
  private muted = false;
  private readonly port: VolumePort;

  constructor(port: VolumePort) {
    this.port = port;
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    // Muted: keep silent at 0 (unmute restores); pre-spawn it just stores — applied in ensureStarted.
    if (!this.muted && this.port.isEngineStarted()) this.apply();
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.port.isEngineStarted()) this.apply();
    return this.muted;
  }

  public getVolume(): number {
    return this.volume;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  /** Mirror the stored volume onto mpv — also the re-apply after spawn/swap. */
  public apply(): void {
    const mpvVolume = toMpvVolume(this.volume, this.muted);
    void this.port
      .sendCommand([
        MPV_COMMANDS.setProperty,
        MPV_PROPERTY_ARGS.volume,
        String(mpvVolume),
      ])
      .catch((e: unknown) => {
        logWarn(`volume-apply-failed: ${describeError(e)}`);
      });
  }
}
