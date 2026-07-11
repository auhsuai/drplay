export class CrossfadeEngine {
  private ctx: AudioContext | null = null;
  private gains: [GainNode | null, GainNode | null] = [null, null];
  private connected: [boolean, boolean] = [false, false];
  private abortController: AbortController | null = null;

  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  connect(audio: HTMLAudioElement, index: 0 | 1): void {
    if (this.connected[index]) return;
    const ctx = this.ctx;
    if (!ctx) return;

    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gain.gain.value = index === 0 ? 1 : 0;

    source.connect(gain);
    gain.connect(ctx.destination);

    this.gains[index] = gain;
    this.connected[index] = true;
  }

  setGain(index: 0 | 1, value: number): void {
    if (this.gains[index]) {
      this.gains[index]!.gain.value = value;
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async crossfade(fromIndex: 0 | 1, toIndex: 0 | 1, durationMs: number): Promise<void> {
    this.abort();
    const controller = new AbortController();
    this.abortController = controller;

    const ctx = this.ctx;
    const fromGain = this.gains[fromIndex];
    const toGain = this.gains[toIndex];
    if (!ctx || !fromGain || !toGain) return;

    const startTime = ctx.currentTime;

    fromGain.gain.cancelScheduledValues(startTime);
    fromGain.gain.setValueAtTime(fromGain.gain.value, startTime);
    fromGain.gain.linearRampToValueAtTime(0, startTime + durationMs / 1000);

    toGain.gain.cancelScheduledValues(startTime);
    toGain.gain.setValueAtTime(toGain.gain.value, startTime);
    toGain.gain.linearRampToValueAtTime(1, startTime + durationMs / 1000);

    return new Promise<void>((resolve) => {
      const check = () => {
        if (controller.signal.aborted) {
          resolve();
          return;
        }
        const elapsed = (ctx.currentTime - startTime) * 1000;
        if (elapsed >= durationMs) {
          fromGain.gain.value = 0;
          toGain.gain.value = 1;
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  destroy(): void {
    this.abort();
    for (const gain of this.gains) {
      try { gain?.disconnect(); } catch { }
    }
    this.gains[0] = null;
    this.gains[1] = null;
    this.connected[0] = false;
    this.connected[1] = false;
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
    }
    this.ctx = null;
  }
}
