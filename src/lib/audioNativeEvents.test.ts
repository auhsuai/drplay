// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createNativeEventHandlers,
  type NativeAudioDeps,
} from "./audioNativeEvents";

vi.mock("../store/playerStore", () => ({
  usePlayerStore: {
    getState: vi.fn(() => ({ setIsPlaying: vi.fn() })),
  },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

// Minimal surface: the handler factory only reads element state fields, and
// events are dispatched straight through _listeners (same convention as the
// AudioController suite, which also never calls mock-typed members directly).
type FakeAudio = {
  paused: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  error: { code: number; message: string } | null;
  _listeners: Record<string, ((e: Event) => void)[]>;
};

function makeFakeAudio(): FakeAudio {
  const listeners: Record<string, ((e: Event) => void)[]> = {};
  return {
    paused: true,
    currentTime: 0,
    duration: 0,
    readyState: 0,
    error: null,
    _listeners: listeners,
  };
}

function register(audio: FakeAudio, handlers: Record<string, EventListener>) {
  for (const [type, handler] of Object.entries(handlers)) {
    (audio._listeners[type] ??= []).push(handler);
  }
}

function fireNative(audio: FakeAudio, type: string) {
  for (const fn of audio._listeners[type] ?? []) fn(new Event(type));
}

// FakeAudio covers only the surface the handlers read; suite-wide convention
// casts through unknown (AudioController.test.ts Task C tests).
function asAudio(fake: FakeAudio): HTMLAudioElement {
  return fake as unknown as HTMLAudioElement;
}

function makeDeps(
  audio: HTMLAudioElement,
  onBuffering: (isBuffering: boolean) => void,
): NativeAudioDeps {
  return {
    isActive: (el) => el === audio,
    emit: (event, payload) => {
      if (event === "buffering")
        onBuffering((payload as { isBuffering: boolean }).isBuffering);
    },
    throttle: { lastTimeUpdate: 0, lastProgressEmit: 0 },
    // Never invoked by the waiting/canplay tests — plain no-ops avoid the
    // vi.fn() Mock typing quirk (TS2348) for unused doubles.
    onUnrecoverableError: () => {},
    onTransientError: () => {},
  };
}

describe("createNativeEventHandlers buffering clear (desktop stuck spinner)", () => {
  let audio: FakeAudio;
  let bufferingEvents: boolean[];

  beforeEach(() => {
    audio = makeFakeAudio();
    bufferingEvents = [];
    register(
      audio,
      createNativeEventHandlers(
        asAudio(audio),
        makeDeps(asAudio(audio), (isBuffering) =>
          bufferingEvents.push(isBuffering),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("regression: waiting while paused then canplay emits buffering false without any playing event", () => {
    fireNative(audio, "waiting");
    expect(bufferingEvents).toEqual([true]);

    fireNative(audio, "canplay");
    expect(bufferingEvents).toEqual([true, false]);
  });

  // `playing` already emits buffering=false unconditionally; `canplay` mirrors
  // that contract — a redundant false is an idempotent no-op for consumers.
  it("canplay without a preceding waiting emits buffering false idempotently", () => {
    fireNative(audio, "canplay");
    expect(bufferingEvents).toEqual([false]);
  });

  it("repeated stall/recover cycles emit matching true/false pairs", () => {
    fireNative(audio, "waiting");
    fireNative(audio, "canplay");
    fireNative(audio, "waiting");
    fireNative(audio, "canplay");
    expect(bufferingEvents).toEqual([true, false, true, false]);
  });

  it("canplay from the INACTIVE element is dropped by the isActive guard", () => {
    const inactive = makeFakeAudio();
    const inactiveEvents: boolean[] = [];
    register(
      inactive,
      createNativeEventHandlers(
        asAudio(inactive),
        makeDeps(asAudio(audio), (isBuffering) =>
          inactiveEvents.push(isBuffering),
        ),
      ),
    );

    fireNative(inactive, "canplay");
    expect(inactiveEvents).toEqual([]);
  });
});
