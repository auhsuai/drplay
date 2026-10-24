// @vitest-environment jsdom
/**
 * The video bar's `current / total` clock. It is a leaf that owns its state
 * and its engine subscriptions, so the 4/s timeupdate re-renders this span
 * only — never VideoPlayerBar or the native video surface.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioController } from "../../../lib/AudioController";
import type { Track } from "../../../types";
import { VideoTimeDisplay } from "./VideoTimeDisplay";

type Handler = (payload?: unknown) => void;

/** Controllable AudioController facade: records subscriptions per event. */
function createAudio() {
  const handlers: Record<string, Handler[]> = {};
  return {
    on: vi.fn((event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
      return () => {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      };
    }),
    emit(event: string, payload?: unknown): void {
      for (const handler of handlers[event] ?? []) handler(payload);
    },
    live(event: string): number {
      return (handlers[event] ?? []).length;
    },
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    getCurrentTrackId: vi.fn<() => string | null>(() => null),
  };
}

type FakeAudio = ReturnType<typeof createAudio>;

function audioOf(fake: FakeAudio): AudioController {
  return fake as unknown as AudioController;
}

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: "t1",
    title: "Video",
    artist: "",
    streamUrl: "/video/t1",
    originalName: "video.mkv",
    ...overrides,
  };
}

function renderDisplay(
  audio: FakeAudio,
  currentTrack: Track,
  active = true,
): ReturnType<typeof render> {
  return render(
    <VideoTimeDisplay
      currentTrack={currentTrack}
      audio={audioOf(audio)}
      active={active}
    />,
  );
}

function clockText(): string {
  return (
    screen.getByTestId("video-time-display").textContent ?? ""
  );
}

afterEach(() => {
  cleanup();
});

describe("VideoTimeDisplay engine seeding", () => {
  it("seeds from the engine when it is already on the current track", () => {
    const audio = createAudio();
    audio.getCurrentTrackId.mockReturnValue("t1");
    audio.getCurrentTime.mockReturnValue(75);
    audio.getDuration.mockReturnValue(750);

    renderDisplay(audio, track());

    expect(clockText()).toBe("1:15 / 12:30");
  });

  it("does NOT seed from another track's engine state (no leaked time)", () => {
    const audio = createAudio();
    audio.getCurrentTrackId.mockReturnValue("previous-video");
    audio.getCurrentTime.mockReturnValue(300);
    audio.getDuration.mockReturnValue(600);

    renderDisplay(
      audio,
      track({ restoreTime: 12, restoreDuration: 240 }),
    );

    expect(clockText()).toBe("0:12 / 4:00");
  });
});

describe("VideoTimeDisplay live events", () => {
  it("advances the current time on timeupdate", () => {
    const audio = createAudio();
    audio.getCurrentTrackId.mockReturnValue("t1");
    audio.getCurrentTime.mockReturnValue(10);
    audio.getDuration.mockReturnValue(600);
    renderDisplay(audio, track());

    act(() => {
      audio.emit("timeupdate", { currentTime: 42, duration: 600 });
    });

    expect(clockText()).toBe("0:42 / 10:00");
  });

  it("updates the total on durationchange while paused (no timeupdate needed)", () => {
    const audio = createAudio();
    audio.getCurrentTrackId.mockReturnValue("t1");
    audio.getCurrentTime.mockReturnValue(75);
    audio.getDuration.mockReturnValue(750);
    renderDisplay(audio, track());

    act(() => {
      audio.emit("durationchange", { duration: 900 });
    });

    expect(clockText()).toBe("1:15 / 15:00");
  });

  it("formats durations over one hour", () => {
    const audio = createAudio();

    renderDisplay(
      audio,
      track({ restoreTime: 5025, restoreDuration: 9296 }),
    );

    expect(clockText()).toBe("1:23:45 / 2:34:56");
  });
});

describe("VideoTimeDisplay guards", () => {
  it("renders --:-- for an unknown total and never emits NaN/Infinity", () => {
    const audio = createAudio();
    renderDisplay(audio, track());

    expect(clockText()).toBe("0:00 / --:--");

    act(() => {
      audio.emit("timeupdate", {
        currentTime: Number.NaN,
        duration: Number.POSITIVE_INFINITY,
      });
      audio.emit("durationchange", { duration: Number.NaN });
    });

    expect(clockText()).toBe("0:00 / --:--");
    expect(clockText()).not.toMatch(/NaN|Infinity/);
  });

  it("resets on a track change and ignores a late event tagged with the old track", () => {
    const audio = createAudio();
    audio.getCurrentTrackId.mockReturnValue("a");
    audio.getCurrentTime.mockReturnValue(50);
    audio.getDuration.mockReturnValue(100);

    const { rerender } = render(
      <VideoTimeDisplay
        currentTrack={track({ id: "a", restoreTime: 10, restoreDuration: 100 })}
        audio={audioOf(audio)}
      />,
    );
    expect(clockText()).toBe("0:50 / 1:40");

    rerender(
      <VideoTimeDisplay
        currentTrack={track({ id: "b", restoreTime: 3, restoreDuration: 200 })}
        audio={audioOf(audio)}
      />,
    );
    expect(clockText()).toBe("0:03 / 3:20");

    act(() => {
      audio.emit("timeupdate", {
        trackId: "a",
        currentTime: 500,
        duration: 600,
      });
    });

    expect(clockText()).toBe("0:03 / 3:20");
  });

  it("drops foreign track events but accepts untagged ones", () => {
    const audio = createAudio();
    renderDisplay(audio, track());

    act(() => {
      audio.emit("durationchange", { trackId: "other", duration: 111 });
      audio.emit("timeupdate", {
        trackId: "other",
        currentTime: 60,
        duration: 111,
      });
    });
    expect(clockText()).toBe("0:00 / --:--");

    act(() => {
      audio.emit("timeupdate", { currentTime: 30, duration: 120 });
    });
    expect(clockText()).toBe("0:30 / 2:00");
  });

  it("never renders non-finite or negative time values", () => {
    const audio = createAudio();
    renderDisplay(
      audio,
      track({ restoreTime: -5, restoreDuration: -1 }),
    );

    expect(clockText()).toBe("0:00 / --:--");
    expect(clockText()).not.toMatch(/NaN|Infinity/);

    act(() => {
      audio.emit("timeupdate", { currentTime: -5, duration: 100 });
    });
    expect(clockText()).toBe("0:00 / 1:40");

    act(() => {
      audio.emit("timeupdate", { currentTime: 20, duration: Number.NaN });
      audio.emit("durationchange", { duration: -100 });
      audio.emit("timeupdate", {
        currentTime: Number.POSITIVE_INFINITY,
        duration: 100,
      });
    });
    expect(clockText()).toBe("0:20 / 1:40");
    expect(clockText()).not.toMatch(/NaN|Infinity|-\d/);
  });
});

describe("VideoTimeDisplay subscription lifecycle", () => {
  it("unsubscribes every handler it registered on unmount", () => {
    const audio = createAudio();
    const { unmount } = renderDisplay(audio, track());

    expect(audio.live("durationchange")).toBe(1);
    expect(audio.live("timeupdate")).toBe(1);

    unmount();

    expect(audio.live("durationchange")).toBe(0);
    expect(audio.live("timeupdate")).toBe(0);
  });

  it("when inactive: no timeupdate, durationchange stays live, seeded value visible", () => {
    const audio = createAudio();
    audio.getCurrentTrackId.mockReturnValue("t1");
    audio.getCurrentTime.mockReturnValue(75);
    audio.getDuration.mockReturnValue(750);

    renderDisplay(audio, track(), false);

    expect(clockText()).toBe("1:15 / 12:30");
    expect(audio.live("timeupdate")).toBe(0);
    expect(audio.live("durationchange")).toBe(1);

    act(() => {
      audio.emit("timeupdate", { currentTime: 99, duration: 750 });
    });
    expect(clockText()).toBe("1:15 / 12:30");

    act(() => {
      audio.emit("durationchange", { duration: 900 });
    });
    expect(clockText()).toBe("1:15 / 15:00");
  });
});
