import type { Track } from "../types";
import type { BufferedSource } from "../utils/bufferedRange";
import type { AudioEventMap, AudioEventHandler } from "./audioNativeEvents";
import { MpvAudioController } from "./mpvAudio";

export type { AudioEventMap, AudioEventHandler } from "./audioNativeEvents";

/**
 * Facade giữ NGUYÊN 100% public API của engine web cũ (plan
 * 2026-09-11-mpv-engine mục 2.1) — ruột đã chuyển sang mpv sidecar qua
 * `MpvAudioController`. UI/hooks tiếp tục gọi `AudioController.getInstance()`
 * mà không đổi import nào.
 */
export class AudioController {
  private static instance: AudioController | undefined;
  private readonly engine = new MpvAudioController();

  private constructor() {}

  public static getInstance(): AudioController {
    if (!AudioController.instance) {
      AudioController.instance = new AudioController();
    }
    return AudioController.instance;
  }

  public on<K extends keyof AudioEventMap>(
    event: K,
    handler: AudioEventHandler<K>,
  ): () => void {
    return this.engine.on(event, handler);
  }

  public async playTrack(track: Track, startTime?: number): Promise<void> {
    await this.engine.playTrack(track, startTime);
  }

  public pause(): void {
    this.engine.pause();
  }

  public seek(time: number): void {
    this.engine.seek(time);
  }

  public setVolume(vol: number): void {
    this.engine.setVolume(vol);
  }

  public toggleMute(): boolean {
    return this.engine.toggleMute();
  }

  public getVolume(): number {
    return this.engine.getVolume();
  }

  public isMuted(): boolean {
    return this.engine.isMuted();
  }

  public getCurrentTime(): number {
    return this.engine.getCurrentTime();
  }

  public getCurrentTrackId(): string | null {
    return this.engine.getCurrentTrackId();
  }

  public getDuration(): number {
    return this.engine.getDuration();
  }

  public getBuffered(): BufferedSource {
    return this.engine.getBuffered();
  }

  public release(): void {
    this.engine.release();
  }
}
