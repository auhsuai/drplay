// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { HomeTab } from "./HomeTab";
import type { Track } from "../../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return {
    Clock: Stub,
    Sparkles: Stub,
    Folder: Stub,
    Repeat: Stub,
    PlusCircle: Stub,
  };
});

const mocks = vi.hoisted(() => ({
  useHomeData: vi.fn(),
  FullRecentViewSpy: vi.fn(
    (props: { recent: Track[]; onBack: () => void; title?: string }) => {
      void props;
      return null;
    },
  ),
}));

vi.mock("./useHomeData", () => ({
  useHomeData: mocks.useHomeData,
}));

vi.mock("./components/FullRecentView", () => ({
  FullRecentView: (props: {
    recent: Track[];
    onBack: () => void;
    title?: string;
  }) => mocks.FullRecentViewSpy(props),
}));

type PremiumGridProps = {
  items: Track[];
  onPlay?: (track: Track, contextQueue?: Track[]) => void;
  isOverlay?: (track: Track, index: number) => boolean;
  onOverlayClick?: () => void;
};

vi.mock("./components/PremiumGrid", () => ({
  PremiumGrid: ({
    items,
    onPlay,
    isOverlay,
    onOverlayClick,
  }: PremiumGridProps) => (
    <div>
      {items.map((track, index) =>
        isOverlay?.(track, index) === true ? (
          <button
            key={track.id}
            data-testid="premium-card-overlay"
            type="button"
            onClick={onOverlayClick}
          >
            {track.title}
          </button>
        ) : (
          <button
            key={track.id}
            data-testid="premium-card"
            type="button"
            onClick={() => {
              onPlay?.(track);
            }}
          >
            {track.title}
          </button>
        ),
      )}
    </div>
  ),
}));

function makeTrack(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    streamUrl: "https://example.invalid/stream",
  };
}

function makeTracks(n: number, prefix: string): Track[] {
  return Array.from({ length: n }, (_, i) =>
    makeTrack(`${prefix}${String(i)}`),
  );
}

function baseProps(over: Record<string, unknown> = {}) {
  return {
    onPlay: vi.fn(),
    onOpenFolder: vi.fn(),
    token: "tok",
    userProfile: null,
    currentTrack: null,
    ...over,
  };
}

function setHomeData(over: Record<string, unknown> = {}) {
  mocks.useHomeData.mockReturnValue({
    recent: [],
    heavy: [],
    discover: [],
    mostVisitedFolders: [],
    recentlyAdded: [],
    greeting: "Hello",
    subtitle: "Subtitle",
    ...over,
  });
}

// The full views replace the grid entirely, so the overlay card disappearing
// means a full view is open and reappearing means it closed.
function isGridVisible() {
  return screen.queryByTestId("premium-card-overlay") !== null;
}

function pressBackspace(init: Record<string, unknown> = {}) {
  fireEvent.keyDown(window, { key: "Backspace", ...init });
}

describe("HomeTab Backspace closes full views (slice B)", () => {
  beforeEach(() => {
    mocks.FullRecentViewSpy.mockClear();
    setHomeData();
  });

  afterEach(() => {
    cleanup();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  it("Backspace closes the Recent full view and returns to the grid", () => {
    // 6 recent tracks with visibleCount 5 (jsdom innerWidth 1024): the last
    // card is the overlay that opens the full view.
    setHomeData({ recent: makeTracks(6, "r") });
    render(<HomeTab {...baseProps()} />);
    fireEvent.click(screen.getByTestId("premium-card-overlay"));
    expect(mocks.FullRecentViewSpy).toHaveBeenCalledTimes(1);
    expect(isGridVisible()).toBe(false);

    pressBackspace();

    expect(isGridVisible()).toBe(true);
  });

  it("Backspace closes the Recently Added full view", () => {
    setHomeData({
      recent: makeTracks(2, "r"),
      recentlyAdded: makeTracks(6, "n"),
    });
    render(<HomeTab {...baseProps()} />);
    fireEvent.click(screen.getByTestId("premium-card-overlay"));
    const firstCall = mocks.FullRecentViewSpy.mock.calls[0]?.[0];
    expect(firstCall?.title).toBe("home.recently_added");
    expect(isGridVisible()).toBe(false);

    pressBackspace();

    expect(isGridVisible()).toBe(true);
  });

  it("Backspace while inactive (keep-alive, hidden tab) does nothing", () => {
    setHomeData({ recent: makeTracks(6, "r") });
    render(<HomeTab {...baseProps({ isActive: false })} />);
    fireEvent.click(screen.getByTestId("premium-card-overlay"));
    expect(isGridVisible()).toBe(false);

    pressBackspace();

    // Still in the full view: the hidden tab must not consume the key.
    expect(isGridVisible()).toBe(false);
  });

  it("Backspace with no full view open is a no-op", () => {
    const onPlay = vi.fn();
    setHomeData({ recent: makeTracks(6, "r") });
    render(<HomeTab {...baseProps({ onPlay })} />);
    expect(isGridVisible()).toBe(true);

    pressBackspace();

    expect(isGridVisible()).toBe(true);
    expect(onPlay).not.toHaveBeenCalled();
    expect(mocks.FullRecentViewSpy).not.toHaveBeenCalled();
  });

  it("Backspace while NowPlaying is open (prop) does not close the full view", () => {
    setHomeData({ recent: makeTracks(6, "r") });
    render(<HomeTab {...baseProps({ isNowPlayingOpen: true })} />);
    fireEvent.click(screen.getByTestId("premium-card-overlay"));
    expect(isGridVisible()).toBe(false);

    pressBackspace();

    expect(isGridVisible()).toBe(false);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])(
    "Backspace with modifier (%o) does not close the full view",
    (mod) => {
      setHomeData({ recent: makeTracks(6, "r") });
      render(<HomeTab {...baseProps()} />);
      fireEvent.click(screen.getByTestId("premium-card-overlay"));
      expect(isGridVisible()).toBe(false);

      pressBackspace(mod);

      expect(isGridVisible()).toBe(false);
    },
  );

  it("Backspace inside an editable field does not close the full view", () => {
    setHomeData({ recent: makeTracks(6, "r") });
    render(
      <div>
        <HomeTab {...baseProps()} />
        <input data-testid="foreign-input" type="text" defaultValue="keep" />
      </div>,
    );
    fireEvent.click(screen.getByTestId("premium-card-overlay"));
    expect(isGridVisible()).toBe(false);
    const foreign = screen.getByTestId("foreign-input");
    foreign.focus();

    pressBackspace();

    expect(isGridVisible()).toBe(false);
    expect(foreign).toHaveValue("keep");
  });
});
