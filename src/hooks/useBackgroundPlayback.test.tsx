// @vitest-environment jsdom
// Task 3 mobile-polish: the "Chạy nhạc nền" (background playback) toggle.
// When OFF, the app pauses the native engine when the WebView goes hidden
// (app backgrounded) and resumes on visible — but ONLY when a track was
// actually playing at the moment of hiding (latch consumed after resume).
// When ON (default), nothing is touched: the foreground service keeps playing.
// Desktop: the hook registers nothing (IS_MOBILE gate), so tray behavior and
// the desktop player stay byte-identical.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  backgroundPlaybackDecision,
  useBackgroundPlayback,
} from "./useBackgroundPlayback";

// Getter-backed platform mock (pattern: LoginScreen.test.tsx) — the hook
// reads IS_MOBILE inside the effect body, so tests flip it mid-suite.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: true }));
vi.mock("../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

// Store mock: the hook reads isPlaying/currentTrack and calls setIsPlaying —
// the PlayerBar effect (single source of truth for engine calls) translates
// the flag flip into engine.pause()/playTrack() in the real app.
const storeMock = vi.hoisted(() => ({
  isPlaying: false,
  currentTrack: { id: "t1", title: "T1" },
  setIsPlaying: vi.fn(),
}));
vi.mock("../store/playerStore", () => ({
  usePlayerStore: { getState: () => storeMock },
}));

function setVisibility(visible: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visible ? "visible" : "hidden",
  });
}

describe("backgroundPlaybackDecision (pure decision helper)", () => {
  it("pauses when hidden + playing + toggle off", () => {
    expect(
      backgroundPlaybackDecision({
        hidden: true,
        playing: true,
        toggleOn: false,
      }),
    ).toBe("pause");
  });

  it("does nothing when hidden + playing + toggle on (foreground service keeps going)", () => {
    expect(
      backgroundPlaybackDecision({
        hidden: true,
        playing: true,
        toggleOn: true,
      }),
    ).toBe("none");
  });

  it("resumes when visible + was playing + toggle off", () => {
    expect(
      backgroundPlaybackDecision({
        hidden: false,
        playing: true,
        toggleOn: false,
      }),
    ).toBe("resume");
  });

  it("does nothing when nothing was playing (hidden or visible)", () => {
    expect(
      backgroundPlaybackDecision({
        hidden: true,
        playing: false,
        toggleOn: false,
      }),
    ).toBe("none");
    expect(
      backgroundPlaybackDecision({
        hidden: false,
        playing: false,
        toggleOn: false,
      }),
    ).toBe("none");
  });
});

describe("useBackgroundPlayback visibility handler", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
    storeMock.isPlaying = false;
    storeMock.currentTrack = { id: "t1", title: "T1" };
    storeMock.setIsPlaying.mockClear();
    setVisibility(true);
  });

  afterEach(() => {
    cleanup();
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it("hidden + toggle off + playing → pause (setIsPlaying(false))", () => {
    renderHook(() => {
      useBackgroundPlayback(false);
    });
    storeMock.isPlaying = true;
    act(() => {
      setVisibility(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(storeMock.setIsPlaying).toHaveBeenCalledWith(false);
  });

  it("hidden + toggle on + playing → no pause (background playback allowed)", () => {
    renderHook(() => {
      useBackgroundPlayback(true);
    });
    storeMock.isPlaying = true;
    act(() => {
      setVisibility(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(storeMock.setIsPlaying).not.toHaveBeenCalled();
  });

  it("hidden + not playing → no pause", () => {
    renderHook(() => {
      useBackgroundPlayback(false);
    });
    act(() => {
      setVisibility(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(storeMock.setIsPlaying).not.toHaveBeenCalled();
  });

  it("visible after background pause → resume (setIsPlaying(true))", () => {
    renderHook(() => {
      useBackgroundPlayback(false);
    });
    storeMock.isPlaying = true;
    act(() => {
      setVisibility(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The native engine pause echoes isPlaying=false through its state events.
    storeMock.isPlaying = false;
    act(() => {
      setVisibility(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(storeMock.setIsPlaying).toHaveBeenCalledTimes(2);
    expect(storeMock.setIsPlaying).toHaveBeenLastCalledWith(true);
  });

  it("resume latch is consumed: second visible without a new pause does not resume again", () => {
    renderHook(() => {
      useBackgroundPlayback(false);
    });
    storeMock.isPlaying = true;
    act(() => {
      setVisibility(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    storeMock.isPlaying = false;
    act(() => {
      setVisibility(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    storeMock.setIsPlaying.mockClear();
    act(() => {
      setVisibility(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(storeMock.setIsPlaying).not.toHaveBeenCalled();
  });

  it("desktop (IS_MOBILE=false) registers no visibility listener — nothing fires", () => {
    platformMock.IS_MOBILE = false;
    renderHook(() => {
      useBackgroundPlayback(false);
    });
    storeMock.isPlaying = true;
    act(() => {
      setVisibility(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(storeMock.setIsPlaying).not.toHaveBeenCalled();
  });
});
