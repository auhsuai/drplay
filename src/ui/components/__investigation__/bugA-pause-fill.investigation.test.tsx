// @vitest-environment jsdom
/**
 * INVESTIGATION-ONLY tests for Bug A ("lâu lâu pause bị mất fillbar, clock
 * hiện 0:00 luôn"). These files are NOT part of the fix; they pin the exact
 * behavior/hole so the fix can be verified later.
 *
 * A1 documents the path the UNCOMMITTED SeekBar fix ([currentTrack] ->
 * [currentTrack?.id]) covers: a same-id object swap must not reset the bar.
 *
 * A2 is the STILL-RED hole on the working tree: the NowPlaying SeekBar is
 * mounted with active=false while the view is closed; it ignores every
 * timeupdate by design. When the view opens (active false->true) while the
 * track is PAUSED, no further timeupdate will ever arrive, so the instance
 * shows 0:00 / 0% forever — same visible symptom as Bug A.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../../types";
import type { AudioController } from "../../../lib/AudioController";
import { SeekBar } from "../SeekBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

const { captureErrorMock } = vi.hoisted(() => ({
  captureErrorMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../utils/errorLog", () => ({
  captureError: captureErrorMock,
}));

const { fakeController } = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  const fakeController = {
    on: vi.fn(),
    getDuration: vi.fn(() => 0),
    getCurrentTime: vi.fn(() => 0),
    getBuffered: vi.fn(() => ({
      duration: 0,
      currentTime: 0,
      buffered: {
        length: 0,
        start: () => 0,
        end: () => 0,
      },
    })),
    seek: vi.fn(),
    _handlers: {} as Record<string, Handler[]>,
    _emit(event: string, payload?: unknown) {
      for (const h of fakeController._handlers[event] ?? []) h(payload);
    },
  };
  return { fakeController };
});

function installFakeOn() {
  fakeController.on.mockImplementation(
    (event: string, handler: (payload: unknown) => void) => {
      (fakeController._handlers[event] ??= []).push(handler);
      return () => {
        fakeController._handlers[event] = (
          fakeController._handlers[event] ?? []
        ).filter((h) => h !== handler);
      };
    },
  );
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "Song",
    artist: "Artist",
    streamUrl: "/drive-stream/track-1",
    ...overrides,
  };
}

const audio = fakeController as unknown as AudioController;

beforeEach(() => {
  fakeController.on.mockClear();
  fakeController.getDuration.mockClear();
  fakeController.getCurrentTime.mockClear();
  fakeController.getBuffered.mockClear();
  fakeController.seek.mockClear();
  captureErrorMock.mockClear();
  installFakeOn();
  fakeController.getDuration.mockReturnValue(0);
  fakeController.getCurrentTime.mockReturnValue(0);
  fakeController._handlers = {};
});

afterEach(() => {
  cleanup();
  fakeController._handlers = {};
});

describe("Bug A investigation — pause + fill/clock", () => {
  it("A1 (covered by uncommitted fix): same-id object swap while paused keeps fill + clock", () => {
    const { rerender } = render(
      <SeekBar currentTrack={makeTrack({ id: "track-A" })} audio={audio} />,
    );

    act(() => {
      fakeController._emit("timeupdate", { currentTime: 25, duration: 100 });
    });
    expect(screen.getByTestId("progress-fill").style.width).toBe("25%");
    expect(screen.getByText("0:25")).toBeTruthy();

    // usePlayer.ts:334 defers metadata (restoreDuration) via setCurrentTrack,
    // producing a NEW object with the SAME id. The next SeekBar render (here
    // the pause re-render) used to re-run the sync effect and reset the bar.
    // The uncommitted [currentTrack?.id] dep makes this a no-op.
    rerender(
      <SeekBar
        currentTrack={makeTrack({ id: "track-A", restoreDuration: 100 })}
        audio={audio}
      />,
    );

    expect(screen.getByTestId("progress-fill").style.width).toBe("25%");
    expect(screen.getByText("0:25")).toBeTruthy();
  });

  it("A2 (RED today): opening the NowPlaying view while paused must resync from the engine clock — stays 0:00 / 0%", () => {
    // Engine truth: the track is paused at 1:03 of 4:00.
    fakeController.getCurrentTime.mockReturnValue(63);
    fakeController.getDuration.mockReturnValue(240);

    const track = makeTrack({ id: "track-A" });
    const { rerender } = render(
      <SeekBar
        currentTrack={track}
        audio={audio}
        active={false}
        keyboardSeek={false}
      />,
    );

    // While the view is closed the track played to 1:03 — the inactive
    // instance ignores the timeupdate by design (render-critical isolation).
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 63, duration: 240 });
    });
    expect(screen.getByTestId("progress-fill").style.width).toBe("0%");

    // User PAUSES at 1:03 (from now on mpv pushes nothing), then opens the
    // NowPlaying view. Activation re-subscribes to timeupdate but no event
    // will ever arrive — the bar must resync from the engine clock instead.
    rerender(
      <SeekBar
        currentTrack={track}
        audio={audio}
        active={true}
        keyboardSeek={false}
      />,
    );

    expect(screen.getByTestId("progress-fill").style.width).toBe("26.25%");
    expect(screen.getByText("1:03")).toBeTruthy();
  });

  it("A2b (variant): activation while PLAYING resyncs from the engine clock, then live timeupdates continue", () => {
    // Same hole, playing variant: the inactive instance missed earlier ticks,
    // and activation must show the current position before the next tick.
    fakeController.getCurrentTime.mockReturnValue(63);
    fakeController.getDuration.mockReturnValue(240);

    const track = makeTrack({ id: "track-A" });
    const { rerender } = render(
      <SeekBar
        currentTrack={track}
        audio={audio}
        active={false}
        keyboardSeek={false}
      />,
    );

    act(() => {
      fakeController._emit("timeupdate", { currentTime: 50, duration: 240 });
    });
    expect(screen.getByTestId("progress-fill").style.width).toBe("0%");

    rerender(
      <SeekBar
        currentTrack={track}
        audio={audio}
        active={true}
        keyboardSeek={false}
      />,
    );
    expect(screen.getByTestId("progress-fill").style.width).toBe("26.25%");
    expect(screen.getByText("1:03")).toBeTruthy();

    // Live playback continues: the next timeupdate takes over normally.
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 72, duration: 240 });
    });
    expect(screen.getByTestId("progress-fill").style.width).toBe("30%");
  });
});
