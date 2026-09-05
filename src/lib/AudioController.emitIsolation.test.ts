// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { captureError } from "../utils/errorLog";

vi.mock("../store/playerStore", () => ({
  usePlayerStore: {
    getState: vi.fn(() => ({ setIsPlaying: vi.fn() })),
  },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

type FakeAudio = {
  paused: boolean;
  src: string;
  currentTime: number;
  duration: number;
  readyState: number;
  volume: number;
  error: { code: number; message: string } | null;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _listeners: Record<string, ((e: Event) => void)[]>;
};

const audioElements: FakeAudio[] = [];

function makeFakeAudio(): FakeAudio {
  const listeners: Record<string, ((e: Event) => void)[]> = {};
  const audio: FakeAudio = {
    paused: true,
    src: "",
    currentTime: 0,
    duration: 0,
    readyState: 0,
    volume: 1,
    error: null,
    play: vi.fn(),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn(),
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

function fireProgress(audio: FakeAudio): void {
  for (const fn of audio._listeners["progress"] ?? [])
    fn(new Event("progress"));
}

function audioEl(index: number): FakeAudio {
  const el = audioElements[index];
  if (el === undefined)
    throw new Error(`expected audio element at index ${String(index)}`);
  return el;
}

describe("AudioController emit isolation", () => {
  let AudioControllerClass: typeof import("../lib/AudioController").AudioController;

  beforeEach(async () => {
    audioElements.length = 0;
    vi.stubGlobal(
      "Audio",
      vi.fn(function () {
        const el = makeFakeAudio();
        audioElements.push(el);
        return el;
      }),
    );
    vi.resetModules();
    const mod = await import("../lib/AudioController");
    AudioControllerClass = mod.AudioController;
    vi.mocked(captureError).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throw at handler k still delivers payload to k+1 in registration order", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack({
      id: "A",
      title: "A",
      artist: "Artist",
      streamUrl: "/drive-stream/A",
    });
    const active = audioEl(1);
    const order: string[] = [];
    const spy2 = vi.fn(() => {
      order.push("second");
    });
    const spy3 = vi.fn(() => {
      order.push("third");
    });
    ctrl.on("progress", () => {
      order.push("first");
      throw new Error("boom-first");
    });
    ctrl.on("progress", spy2);
    ctrl.on("progress", spy3);

    // Old buggy emit rethrows — swallow it here so the isolation assertions
    // below produce the canonical RED log (spy2 got 0) instead of an abort.
    try {
      fireProgress(active);
    } catch {
      // Old behavior: throw propagated and later handlers never ran.
    }

    expect(spy2).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledWith(undefined);
    expect(spy3).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("routes each throwing handler to the error pipeline exactly once", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack({
      id: "A",
      title: "A",
      artist: "Artist",
      streamUrl: "/drive-stream/A",
    });
    const active = audioEl(1);
    ctrl.on("progress", () => {
      throw new Error("boom-pipeline");
    });
    const after = vi.fn();
    ctrl.on("progress", after);

    try {
      fireProgress(active);
    } catch {
      // Old behavior: no pipeline routing, throw propagated.
    }

    expect(after).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("variant: two throwing handlers do not block the handler after them", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack({
      id: "A",
      title: "A",
      artist: "Artist",
      streamUrl: "/drive-stream/A",
    });
    const active = audioEl(1);
    ctrl.on("progress", () => {
      throw new Error("boom-1");
    });
    ctrl.on("progress", () => {
      throw new Error("boom-2");
    });
    const survivor = vi.fn();
    ctrl.on("progress", survivor);

    try {
      fireProgress(active);
    } catch {
      // Old behavior: first throw aborts the whole chain.
    }

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe + emit with no listener neither crashes nor logs", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack({
      id: "A",
      title: "A",
      artist: "Artist",
      streamUrl: "/drive-stream/A",
    });
    const active = audioEl(1);
    const spy = vi.fn();
    const unsub = ctrl.on("progress", spy);
    unsub();

    expect(() => {
      fireProgress(active);
    }).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });
});
