// @vitest-environment jsdom
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { Track } from "../../../types";
import { NowPlayingControls } from "./NowPlayingControls";
import { NowPlayingView } from "../NowPlayingView";

// Mobile-first test file: the platform flag is static true (repo convention —
// usePlayer.mobile.test.tsx), flipped to false only for the desktop-unchanged
// assertion. The view-level tests render the REAL NowPlayingControls (no
// stub) so the ±5s seek wiring is exercised end-to-end through the shared
// seekRelative engine path.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: true }));
vi.mock("../../../utils/platform", () => ({
  IS_MOBILE: platformMock.IS_MOBILE,
}));

vi.mock("../../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
  V_PLACEHOLDER: 9,
  UNKNOWN_ARTIST: "Unknown Artist",
}));

const engine = vi.hoisted(() => ({
  // Explicit function generic: mock.calls entries stay indexable
  // ([event, handler]) without naming unused implementation params, and the
  // handler slot is already a function type (no per-access casts).
  on: vi.fn<
    (event: string, handler?: (...args: never[]) => void) => () => void
  >(() => vi.fn()),
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 0),
  getBuffered: vi.fn(() => ({ length: 0 })),
  seek: vi.fn(),
  pause: vi.fn(),
}));
vi.mock("../../../lib/nativeAudioBridge", () => ({
  getPlaybackEngine: () => engine,
}));

vi.mock("../../components/SeekBar", () => ({ SeekBar: () => null }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("lucide-react", () => {
  const icons = [
    "Music",
    "ChevronDown",
    "Play",
    "Pause",
    "SkipBack",
    "SkipForward",
    "Repeat",
    "Repeat1",
    "Shuffle",
    "RotateCcw",
    "RotateCw",
  ];
  const Stub = ({ className }: { className?: string }) => (
    <span data-icon="stub" className={className} />
  );
  // The load spinner must be OBSERVABLE for the buffering/track-load tests
  // (same tagged-stub pattern as PlayerBar.test.tsx).
  const spinnerStub = ({ className }: { className?: string }) => (
    <span data-testid="loading-spinner" className={className} />
  );
  // Explicit entry tuples keep Object.fromEntries on the typed overload
  // (untyped mixed arrays resolve to an `any` return — lint error).
  type IconStub = (props: { className?: string }) => ReactElement;
  const entries: Array<[string, IconStub]> = [
    ...icons.map((n): [string, IconStub] => [n, Stub]),
    ["LoaderCircle", spinnerStub],
  ];
  return Object.fromEntries(entries);
});

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "My Song",
    artist: "Real Artist",
    streamUrl: "",
    ...overrides,
  };
}

describe("NowPlayingControls mobile — 5-button transport (prev/-5s/play/+5s/next)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
  });

  afterEach(() => {
    cleanup();
    platformMock.IS_MOBILE = true;
  });

  function renderControls(
    overrides: Partial<Parameters<typeof NowPlayingControls>[0]> = {},
  ) {
    const props = {
      isPlaying: false,
      onTogglePlay: vi.fn(),
      onNextTrack: vi.fn(),
      onPrevTrack: vi.fn(),
      playMode: "normal" as const,
      onTogglePlayMode: vi.fn(),
      onRewind5: vi.fn(),
      onForward5: vi.fn(),
      ...overrides,
    };
    render(<NowPlayingControls {...props} />);
    return props;
  }

  it("renders 5 transport buttons in the user-chosen order, seek flanking play", () => {
    renderControls();
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter(Boolean);
    expect(labels).toEqual([
      "Previous track",
      "Rewind 5 seconds",
      "Play/Pause",
      "Forward 5 seconds",
      "Next track",
    ]);
    const playBtn = screen.getByRole("button", { name: "Play/Pause" });
    expect(playBtn.parentElement?.className).toContain("gap-2");
  });

  it("rewind/forward clicks call the seek handlers", () => {
    const props = renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Rewind 5 seconds" }));
    expect(props.onRewind5).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Forward 5 seconds" }));
    expect(props.onForward5).toHaveBeenCalledTimes(1);
  });

  it("compacts transport buttons on mobile (Task 9: 36px side, 44px play, 20px icons)", () => {
    renderControls();
    const playBtn = screen.getByRole("button", { name: "Play/Pause" });
    expect(playBtn.className).toContain("w-[44px]");
    expect(playBtn.className).toContain("h-[44px]");
    const rewind = screen.getByRole("button", { name: "Rewind 5 seconds" });
    expect(rewind.className).toContain("p-2");
    expect(
      rewind.querySelector("[data-icon]")?.getAttribute("class"),
    ).toContain("w-5");
  });

  it("desktop: no seek buttons, center group classes byte-identical", async () => {
    // IS_MOBILE is a module-level constant evaluated at import time, so this
    // scenario re-imports the component with a fresh desktop platform mock
    // (repo convention — AppShell.test.tsx renderAppShell).
    vi.resetModules();
    vi.doMock("../../../utils/platform", () => ({ IS_MOBILE: false }));
    const { NowPlayingControls: DesktopControls } =
      await import("./NowPlayingControls");
    const desktopProps = {
      isPlaying: false,
      onTogglePlay: vi.fn(),
      onNextTrack: vi.fn(),
      onPrevTrack: vi.fn(),
      playMode: "normal" as const,
      onTogglePlayMode: vi.fn(),
      onRewind5: vi.fn(),
      onForward5: vi.fn(),
    };
    render(<DesktopControls {...desktopProps} />);
    expect(
      screen.queryByRole("button", { name: "Rewind 5 seconds" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Forward 5 seconds" }),
    ).toBeNull();
    const playBtn = screen.getByRole("button", { name: "Play/Pause" });
    expect(playBtn.parentElement?.className).toBe(
      "flex items-center gap-6 px-6",
    );
    expect(playBtn.className).toContain("w-10 h-10");
  });

  it("desktop: buffering does NOT swap in a spinner (overlay unchanged on desktop)", async () => {
    vi.resetModules();
    vi.doMock("../../../utils/platform", () => ({ IS_MOBILE: false }));
    const { NowPlayingControls: DesktopControls } =
      await import("./NowPlayingControls");
    render(
      <DesktopControls
        isPlaying={true}
        isBuffering={true}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onRewind5={vi.fn()}
        onForward5={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("loading-spinner")).toBeNull();
  });

  it("shows the load spinner while buffering with play intent (mobile)", () => {
    renderControls({ isPlaying: true, isBuffering: true });
    const spinner = screen.getByTestId("loading-spinner");
    expect(spinner.className).toContain("animate-spin");
  });

  it("shows the spinner while download or track-change load feedback is active", () => {
    renderControls({ isDownloading: true });
    expect(screen.getByTestId("loading-spinner")).toBeTruthy();
    cleanup();
    renderControls({ isLoadingTrack: true });
    expect(screen.getByTestId("loading-spinner")).toBeTruthy();
  });

  it("hides the spinner when the user paused mid-buffer (pause wins instantly)", () => {
    renderControls({ isPlaying: false, isBuffering: true });
    expect(screen.queryByTestId("loading-spinner")).toBeNull();
  });

  it("no spinner while playing without load feedback", () => {
    renderControls({ isPlaying: true });
    expect(screen.queryByTestId("loading-spinner")).toBeNull();
  });
});

describe("NowPlayingView mobile — ±5s seek wiring through the shared engine", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
  });

  afterEach(() => {
    cleanup();
    platformMock.IS_MOBILE = true;
    engine.seek.mockClear();
    engine.getCurrentTime.mockReturnValue(0);
    engine.getDuration.mockReturnValue(0);
  });

  function renderView() {
    return render(
      <NowPlayingView
        currentTrack={makeTrack()}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onBack={vi.fn()}
        isOpen={false}
        token="tok"
      />,
    );
  }

  it("rewind/forward buttons seek through the shared engine (clamped)", () => {
    engine.getCurrentTime.mockReturnValue(30);
    engine.getDuration.mockReturnValue(100);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Rewind 5 seconds" }));
    expect(engine.seek).toHaveBeenCalledWith(25);

    engine.seek.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Forward 5 seconds" }));
    expect(engine.seek).toHaveBeenCalledWith(35);
  });

  it("clamps forward past duration and no-ops while duration is unloaded", () => {
    engine.getCurrentTime.mockReturnValue(97);
    engine.getDuration.mockReturnValue(100);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Forward 5 seconds" }));
    expect(engine.seek).toHaveBeenCalledWith(100);

    engine.seek.mockClear();
    engine.getDuration.mockReturnValue(0);
    fireEvent.click(screen.getByRole("button", { name: "Rewind 5 seconds" }));
    expect(engine.seek).not.toHaveBeenCalled();
  });

  it("wires engine buffering + outcome edges into the overlay spinner (play intent)", () => {
    // engine.on is a shared accumulating mock — earlier view renders in this
    // file left stale subscriptions behind; only THIS render's handlers may
    // be invoked.
    engine.on.mockClear();
    render(
      <NowPlayingView
        currentTrack={makeTrack()}
        isPlaying={true}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onBack={vi.fn()}
        isOpen={false}
        token="tok"
      />,
    );

    // The recorded handlers carry no parameter info in the mock's inferred
    // type — one narrow cast per event signature (never[] params keep the
    // cast comparable without `any`).
    const findHandler = (
      event: string,
    ): ((...args: never[]) => void) | undefined =>
      engine.on.mock.calls.find((call) => call[0] === event)?.[1];
    const bufferingHandler = findHandler("buffering") as
      ((p: { isBuffering: boolean }) => void) | undefined;
    const playHandler = findHandler("play") as (() => void) | undefined;
    const errorHandler = findHandler("error") as (() => void) | undefined;
    expect(bufferingHandler).toBeTruthy();
    expect(playHandler).toBeTruthy();
    expect(errorHandler).toBeTruthy();

    // Fresh load armed on mount (isPlaying=true) and buffering keeps it up.
    expect(screen.getByTestId("loading-spinner")).toBeTruthy();
    act(() => {
      bufferingHandler?.({ isBuffering: true });
    });
    expect(screen.getByTestId("loading-spinner")).toBeTruthy();

    // Buffering alone ending is not an outcome — the spinner waits for play.
    act(() => {
      bufferingHandler?.({ isBuffering: false });
    });
    expect(screen.getByTestId("loading-spinner")).toBeTruthy();

    // READY: the play edge proves the load finished — spinner hides.
    act(() => {
      playHandler?.();
    });
    expect(screen.queryByTestId("loading-spinner")).toBeNull();
  });

  it("hides the overlay spinner when the load errors out", () => {
    engine.on.mockClear();
    render(
      <NowPlayingView
        currentTrack={makeTrack()}
        isPlaying={true}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onBack={vi.fn()}
        isOpen={false}
        token="tok"
      />,
    );
    const errorHandler = engine.on.mock.calls.find(
      (call) => call[0] === "error",
    )?.[1] as (() => void) | undefined;
    expect(errorHandler).toBeTruthy();

    expect(screen.getByTestId("loading-spinner")).toBeTruthy();
    act(() => {
      errorHandler?.();
    });
    expect(screen.queryByTestId("loading-spinner")).toBeNull();
  });
});
