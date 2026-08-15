// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  on: vi.fn(() => vi.fn()),
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
  return Object.fromEntries(icons.map((n) => [n, Stub]));
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

  it("compacts transport buttons on mobile (Task 9: 30px side, 34px play, 18px icons)", () => {
    renderControls();
    const playBtn = screen.getByRole("button", { name: "Play/Pause" });
    expect(playBtn.className).toContain("w-[34px]");
    expect(playBtn.className).toContain("h-[34px]");
    const rewind = screen.getByRole("button", { name: "Rewind 5 seconds" });
    expect(rewind.className).toContain("p-1.5");
    expect(
      rewind.querySelector("[data-icon]")?.getAttribute("class"),
    ).toContain("w-[18px]");
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
});
