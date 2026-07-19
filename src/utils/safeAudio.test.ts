// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { safePlay, safePause } from './safeAudio';

// Minimal fake of the bits of HTMLAudioElement that safeAudio touches.
// `play()` returns a Promise we control externally so we can model two
// overlapping play() calls resolving in arbitrary order.
function makeFakeAudio() {
  const ctrl: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: any) => void;
  } = {} as any;
  ctrl.promise = new Promise<void>((res, rej) => {
    ctrl.resolve = res;
    ctrl.reject = rej;
  });

  const audio: any = {
    paused: true,
    play() {
      this.paused = false;
      return ctrl.promise;
    },
    pause() {
      this.paused = true;
    },
    _ctrl: ctrl,
  };
  return audio as unknown as HTMLAudioElement & {
    paused: boolean;
    pause: () => void;
    _ctrl: typeof ctrl;
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('safeAudio race (fast track switch auto-stop)', () => {
  it('overlapping safePlay does not auto-stop the newer track (regression)', async () => {
    const audioB = makeFakeAudio();
    const audioC = makeFakeAudio();
    const pauseSpy = vi.spyOn(audioC as any, 'pause');

    // Start playing B, then immediately switch to C before B resolves.
    const playB = safePlay(audioB);
    const playC = safePlay(audioC);

    // B resolves first — this is the exact ordering that triggered the bug.
    audioB._ctrl.resolve();
    await playB;

    // C must still be considered the active, playing element. Invoking
    // safePause(C) must NOT directly pause C (that was the erroneous
    // auto-stop). With the bug present, B's `finally` had nulled the globals,
    // so safePause(C) took the else-branch and called C.pause() immediately
    // (paused -> auto-stop). The fix keeps C playing at this point.
    safePause(audioC);
    expect(pauseSpy).not.toHaveBeenCalled();
    expect((audioC as any).paused).toBe(false);

    // When C eventually finishes, safePause's deferred pause fires once.
    audioC._ctrl.resolve();
    await playC;
    await tick();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('normal non-overlapping play then pause still works', async () => {
    const audio = makeFakeAudio();
    const pauseSpy = vi.spyOn(audio as any, 'pause');

    const play = safePlay(audio);
    audio._ctrl.resolve();
    await play;
    expect((audio as any).paused).toBe(false);

    // After play resolves, globals return to idle; pausing should pause now.
    safePause(audio);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });
});
