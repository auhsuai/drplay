import { afterEach, describe, expect, it, vi } from "vitest";
import { onceAfterFirstAudio, type DeferAudioSource } from "./deferOnce";

// Hand-rolled fake for the minimal audio surface: captures each handler and
// exposes its unsub so tests can prove cleanup actually ran.
function makeAudio() {
  let firstAudioHandler: ((payload?: unknown) => void) | undefined;
  let errorHandler: ((payload?: unknown) => void) | undefined;
  const unsubFirstAudio = vi.fn(() => {
    firstAudioHandler = undefined;
  });
  const unsubError = vi.fn(() => {
    errorHandler = undefined;
  });
  const on = vi.fn(
    (event: "first-audio" | "error", handler: (payload?: unknown) => void) => {
      if (event === "first-audio") {
        firstAudioHandler = handler;
        return unsubFirstAudio;
      }
      errorHandler = handler;
      return unsubError;
    },
  );

  return {
    source: { on } as unknown as DeferAudioSource,
    on,
    unsubFirstAudio,
    unsubError,
    emitFirstAudio: (payload?: unknown) => firstAudioHandler?.(payload),
    emitError: (payload?: unknown) =>
      errorHandler?.(payload ?? { message: "boom", code: "E_MPV" }),
    hasFirstAudio: () => firstAudioHandler !== undefined,
    hasError: () => errorHandler !== undefined,
  };
}

describe("onceAfterFirstAudio", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires once on first-audio, unsubscribes both listeners and clears the fallback timer", () => {
    vi.useFakeTimers();
    const audio = makeAudio();
    const onFire = vi.fn();
    const onDrop = vi.fn();
    const controller = new AbortController();

    onceAfterFirstAudio(audio.source, controller.signal, {
      fallbackMs: 9000,
      onFire,
      onDrop,
    });

    expect(audio.on).toHaveBeenCalledTimes(2);
    audio.emitFirstAudio();

    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
    expect(audio.unsubFirstAudio).toHaveBeenCalledTimes(1);
    expect(audio.unsubError).toHaveBeenCalledTimes(1);
    expect(audio.hasFirstAudio()).toBe(false);
    expect(audio.hasError()).toBe(false);

    // The fallback timer was cleared: nothing fires when it would have.
    vi.advanceTimersByTime(9000);
    expect(onFire).toHaveBeenCalledTimes(1);

    // Late error / abort after settling are ignored.
    audio.emitError();
    controller.abort();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("is a silent no-op when the signal is already aborted: no subscribe, no timer", () => {
    vi.useFakeTimers();
    const audio = makeAudio();
    const onFire = vi.fn();
    const onDrop = vi.fn();
    const controller = new AbortController();
    controller.abort();

    onceAfterFirstAudio(audio.source, controller.signal, {
      fallbackMs: 9000,
      onFire,
      onDrop,
    });

    // An already-aborted signal never replays the abort event, so subscribing
    // would leak the listeners/timer forever. Nothing may be registered here.
    expect(audio.on).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
    // onDrop must NOT run: teardown belongs to the replacing operation.
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("drops once on a late abort and frees both listeners + timer", () => {
    vi.useFakeTimers();
    const audio = makeAudio();
    const onFire = vi.fn();
    const onDrop = vi.fn();
    const controller = new AbortController();

    onceAfterFirstAudio(audio.source, controller.signal, {
      fallbackMs: 9000,
      onFire,
      onDrop,
    });

    controller.abort();

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(audio.unsubFirstAudio).toHaveBeenCalledTimes(1);
    expect(audio.unsubError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("falls back to the timer when first-audio never arrives, then cleans up", () => {
    vi.useFakeTimers();
    const audio = makeAudio();
    const onFire = vi.fn();
    const onDrop = vi.fn();
    const controller = new AbortController();

    onceAfterFirstAudio(audio.source, controller.signal, {
      fallbackMs: 9000,
      onFire,
      onDrop,
    });

    vi.advanceTimersByTime(8999);
    expect(onFire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(audio.unsubFirstAudio).toHaveBeenCalledTimes(1);
    expect(audio.unsubError).toHaveBeenCalledTimes(1);
    expect(audio.hasFirstAudio()).toBe(false);
    expect(audio.hasError()).toBe(false);

    controller.abort();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("R2.1: first-audio of ANOTHER track never fires — waits for its own track", () => {
    const audio = makeAudio();
    const onFire = vi.fn();
    const onDrop = vi.fn();
    const controller = new AbortController();

    onceAfterFirstAudio(audio.source, controller.signal, {
      trackId: "B",
      onFire,
      onDrop,
    });

    audio.emitFirstAudio({ trackId: "A", attempt: 1 });
    expect(onFire).not.toHaveBeenCalled();
    expect(audio.hasFirstAudio()).toBe(true); // still waiting for B

    audio.emitFirstAudio({ trackId: "B", attempt: 2 });
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(audio.unsubFirstAudio).toHaveBeenCalledTimes(1);
    expect(audio.unsubError).toHaveBeenCalledTimes(1);
  });

  it("R2.1: error of ANOTHER track never drops the defer — its own error does", () => {
    const audio = makeAudio();
    const onFire = vi.fn();
    const onDrop = vi.fn();
    const controller = new AbortController();

    onceAfterFirstAudio(audio.source, controller.signal, {
      trackId: "B",
      onFire,
      onDrop,
    });

    audio.emitError({ message: "boom", code: "E_MPV", trackId: "A" });
    expect(onDrop).not.toHaveBeenCalled();
    expect(audio.hasError()).toBe(true); // still armed for B

    audio.emitError({ message: "boom", code: "E_MPV", trackId: "B" });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("R2.1 legacy: no trackId option (old callers) keeps fire/drop on any event", () => {
    vi.useFakeTimers();
    const audio = makeAudio();
    const onFire = vi.fn();
    const onDrop = vi.fn();
    const controller = new AbortController();

    onceAfterFirstAudio(audio.source, controller.signal, {
      fallbackMs: 9000,
      onFire,
      onDrop,
    });

    audio.emitFirstAudio({ trackId: "anything" });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("R2.1 legacy: untagged events keep old behavior even when trackId is set", () => {
    const audio = makeAudio();
    const onFire = vi.fn();
    const onDrop = vi.fn();
    const controller = new AbortController();

    onceAfterFirstAudio(audio.source, controller.signal, {
      trackId: "B",
      onFire,
      onDrop,
    });

    audio.emitFirstAudio(); // no identity at all (older sender)
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
