// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Track } from '../App';

vi.mock('../store/playerStore', () => ({
  usePlayerStore: {
    getState: () => ({ setIsPlaying: vi.fn() }),
  },
}));

vi.mock('../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

type FakeAudio = {
  seq: string[];
  paused: boolean;
  src: string;
  currentTime: number;
  duration: number;
  readyState: number;
  volume: number;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _listeners: Record<string, ((e: Event) => void)[]>;
};

const audioElements: FakeAudio[] = [];

function makeFakeAudio(): FakeAudio {
  const listeners: Record<string, ((e: Event) => void)[]> = {};
  const seq: string[] = [];
  const audio: FakeAudio = {
    seq,
    paused: true,
    src: '',
    currentTime: 0,
    duration: 0,
    readyState: 0,
    volume: 1,
    play: vi.fn(async function (this: any) {
      this.paused = false;
      seq.push('play');
    }),
    pause: vi.fn(function (this: any) {
      this.paused = true;
      seq.push('pause');
    }),
    load: vi.fn(() => {
      seq.push('load');
    }),
    removeAttribute: vi.fn(function (this: any, name: string) {
      if (name === 'src') {
        this.src = '';
        seq.push('removeAttribute:src');
      }
    }),
    setAttribute: vi.fn(),
    addEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
      (listeners[type] ??= []).push(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    }),
    _listeners: listeners,
  };
  return audio;
}

function fireError(audio: FakeAudio) {
  for (const fn of audio._listeners['error'] ?? []) fn(new Event('error'));
}

function fireLoadedMetadata(audio: FakeAudio) {
  for (const fn of audio._listeners['loadedmetadata'] ?? []) fn(new Event('loadedmetadata'));
}

describe('AudioController retry lifecycle', () => {
  let AudioControllerClass: typeof import('../lib/AudioController').AudioController;

  beforeEach(async () => {
    vi.useFakeTimers();
    audioElements.length = 0;
    vi.stubGlobal(
      'Audio',
      vi.fn(function () {
        const el = makeFakeAudio();
        audioElements.push(el);
        return el;
      })
    );
    // Fresh module each test so the singleton + retry state never leaks.
    vi.resetModules();
    const mod = await import('../lib/AudioController');
    AudioControllerClass = mod.AudioController;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const trackA: Track = { id: 'A', title: 'Track A', artist: 'Artist', streamUrl: '/drive-stream/A' };
  const trackB: Track = { id: 'B', title: 'Track B', artist: 'Artist', streamUrl: '/drive-stream/B' };

  it('B1 regression: stale retry timer does not touch the new track after a switch', async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    ctrl.on('error', errorHandler);

    await ctrl.playTrack(trackA);
    const audioA = audioElements[1]; // playTrack flips activeIndex 0 -> 1
    fireError(audioA);

    await ctrl.playTrack(trackB);
    const audioB = audioElements[0]; // now active

    await vi.advanceTimersByTimeAsync(2000);

    // Only the original 'network_interrupted' emit — the stale timer must not
    // schedule anything else on the new track. removeAttribute was called
    // exactly once: the legitimate cleanup of the empty audio1 during
    // playTrack(A) — a zombie retry would add a second call.
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(audioB.removeAttribute).toHaveBeenCalledTimes(1);
    expect(audioB.src).not.toContain('retry=');
    expect(audioB.play).toHaveBeenCalledTimes(1); // only the playTrack(B) call
  });

  it('B1 variant: retry still fires for the still-active track and restores position', async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    const audio = audioElements[1];
    audio.currentTime = 5;

    fireError(audio);
    await vi.advanceTimersByTimeAsync(2000);

    expect(audio.src).toContain('retry=');
    expect(audio.load).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();

    fireLoadedMetadata(audio);
    expect(audio.currentTime).toBe(5);
    expect(audio.removeEventListener).toHaveBeenCalled();
  });

  it('B1 variant: retries are capped (retryCount < 3) — an error past the cap gives up and schedules no zombie retry', async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    const endedHandler = vi.fn();
    ctrl.on('error', errorHandler);
    ctrl.on('ended', endedHandler);

    await ctrl.playTrack(trackA);
    const audio = audioElements[1];

    for (let i = 0; i < 4; i++) fireError(audio);
    await vi.advanceTimersByTimeAsync(10_000);

    const networkMsgs = errorHandler.mock.calls.filter((c) => c[0].code === 'network_interrupted');
    const formatMsgs = errorHandler.mock.calls.filter((c) => c[0].code === 'format_error');
    expect(networkMsgs).toHaveLength(2); // retryCount 1 and 2 are < 3
    expect(formatMsgs).toHaveLength(2); // retryCount 3 and 4 give up
    expect(endedHandler).toHaveBeenCalledTimes(2);
    // After giving up, no pending retry may fire: play() was only called by
    // the original playTrack.
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).not.toContain('retry=');
  });

  it('B2 regression: old audio gets load() immediately after removeAttribute("src") when switching tracks', async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    await ctrl.playTrack(trackB);

    for (const el of audioElements) {
      const iPause = el.seq.indexOf('pause');
      const iRemove = el.seq.indexOf('removeAttribute:src');
      expect(iPause).toBeGreaterThanOrEqual(0);
      expect(iRemove).toBeGreaterThan(iPause);
      // The MDN 3-step release: pause -> removeAttribute('src') -> load()
      expect(el.seq[iRemove + 1]).toBe('load');
    }
  });

  it('B3 regression: release() releases both elements (pause + removeAttribute + load) and resets state', async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);

    ctrl.release();

    for (const el of audioElements) {
      const iPause = el.seq.indexOf('pause');
      const iRemove = el.seq.indexOf('removeAttribute:src');
      const iLoad = el.seq.lastIndexOf('load');
      expect(iPause).toBeGreaterThanOrEqual(0);
      expect(iRemove).toBeGreaterThan(iPause);
      expect(iLoad).toBeGreaterThan(iRemove);
    }

    // State must be reset: playing the SAME track again must go through the
    // full setup path (which activates the other element), not the
    // early-return resume path.
    await ctrl.playTrack(trackA);
    expect(audioElements[0].play).toHaveBeenCalledTimes(1);
  });

  it('B3 variant: release() cancels a pending retry timer', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    const audio = audioElements[1];

    fireError(audio);
    ctrl.release();
    await vi.advanceTimersByTimeAsync(2000);

    expect(clearSpy).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).not.toContain('retry=');
  });

  describe('AudioController event-listener lifecycle', () => {
    it('registers exactly 6 native listeners, one per event type, on each element', async () => {
      AudioControllerClass.getInstance();
      const expected = ['timeupdate', 'durationchange', 'waiting', 'playing', 'pause', 'ended', 'error'];
      expect(audioElements).toHaveLength(2);
      for (const el of audioElements) {
        expect(Object.keys(el._listeners).sort()).toEqual([...expected].sort());
        for (const type of expected) {
          expect(el._listeners[type]).toHaveLength(1);
        }
      }
    });

    it('release() keeps native listeners attached — error events still reach consumers after a release + replay cycle (logout -> re-login reuse flow)', async () => {
      const ctrl = AudioControllerClass.getInstance();
      const errorHandler = vi.fn();
      ctrl.on('error', errorHandler);

      await ctrl.playTrack(trackA);
      ctrl.release();

      // Re-login: same singleton, same elements. release() reset the track
      // state, so playTrack goes through the full setup path again and the
      // OTHER element becomes active.
      await ctrl.playTrack(trackA);
      const active = audioElements.find((el) => el.src.includes('drive-stream'))!;

      // The error listener must still be attached on the active element
      // after release(). If someone later "fixes" release() by detaching the
      // native listeners, this emit never fires and the test fails.
      fireError(active);
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'network_interrupted' })
      );
    });

    it('repeated playTrack cycles never accumulate duplicate native listeners on an element', async () => {
      const ctrl = AudioControllerClass.getInstance();
      await ctrl.playTrack(trackA);
      await ctrl.playTrack(trackB);
      await ctrl.playTrack(trackA);
      for (const el of audioElements) {
        for (const type of Object.keys(el._listeners)) {
          expect(el._listeners[type]).toHaveLength(1);
        }
      }
    });
  });
});
