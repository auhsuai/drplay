// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Track } from "../../types";
import { NowPlayingView } from "./NowPlayingView";

// Task 12: on mobile the full view shows the title only — no cover art
// container, no artist line, no metadata fetch. Mobile-only test file: the
// platform flag is static true (repo convention — usePlayer.mobile.test.tsx).
const platformMock = vi.hoisted(() => ({ IS_MOBILE: true }));
vi.mock("../../utils/platform", () => ({
  IS_MOBILE: platformMock.IS_MOBILE,
}));

vi.mock("../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
  V_PLACEHOLDER: 9,
  UNKNOWN_ARTIST: "Unknown Artist",
}));

vi.mock("../../lib/nativeAudioBridge", () => ({
  getPlaybackEngine: () => ({
    on: vi.fn(() => vi.fn()),
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    getBuffered: vi.fn(() => ({ length: 0 })),
    seek: vi.fn(),
    pause: vi.fn(),
  }),
}));

// The controls and seekbar are transport UI, out of scope for the metadata
// gate — stub them so the test focuses on the metadata-derived surface.
vi.mock("../components/SeekBar", () => ({ SeekBar: () => null }));
vi.mock("./components/NowPlayingControls", () => ({
  NowPlayingControls: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("lucide-react", () => {
  const icons = ["Music", "ChevronDown"];
  const Stub = () => null;
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

function renderView(
  overrides: Partial<Parameters<typeof NowPlayingView>[0]> = {},
) {
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
      {...overrides}
    />,
  );
}

describe("NowPlayingView mobile gate (IS_MOBILE) — title only", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the title but no artist and no cover art", () => {
    renderView();
    expect(screen.getByText("My Song")).not.toBeNull();
    expect(screen.queryByText("Real Artist")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not render the empty-track placeholder on mobile (same title-only surface)", () => {
    renderView({ currentTrack: null });
    expect(screen.getByText("player.no_track")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
