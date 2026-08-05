// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeTab } from "./HomeTab";
import type { Track, UserProfile } from "../../types";
import type { DriveFileItem } from "../../utils/driveApi";
import type { FolderVisitEntry } from "../../utils/history";
import { SYNC_EVENT_NAMES } from "../../utils/proSyncManager";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: "en" },
  }),
}));

vi.mock("lucide-react", () => {
  const icons = [
    "Clock",
    "Sparkles",
    "Folder",
    "Repeat",
    "PlusCircle",
    "ChevronRight",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  getRecentlyPlayed: vi.fn(),
  getHeavyRotation: vi.fn(),
  getRandomDiscoveries: vi.fn(),
  getMostVisitedFolders: vi.fn(),
  getRecentlyAddedAudioFiles: vi.fn(),
  captureError: vi.fn(),
  prefetchVisibleTracks: vi.fn(),
  FullRecentViewSpy: vi.fn((props: FullRecentViewProps) => {
    void props;
    return null;
  }),
}));

vi.mock("../../utils/history", () => ({
  getRecentlyPlayed: mocks.getRecentlyPlayed,
  getHeavyRotation: mocks.getHeavyRotation,
  getRandomDiscoveries: mocks.getRandomDiscoveries,
  getMostVisitedFolders: mocks.getMostVisitedFolders,
}));
vi.mock("../../utils/driveApi", () => ({
  getRecentlyAddedAudioFiles: mocks.getRecentlyAddedAudioFiles,
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../utils/streamPrefetcher", () => ({
  prefetchVisibleTracks: mocks.prefetchVisibleTracks,
}));
vi.mock("../../hooks/useResponsiveItems", () => ({
  useResponsiveItems: () => 5,
}));
// Child components pull in metadata fetching / virtualized lists — stand-ins
// keep the HomeTab slice under test focused on section-level behavior. The
// PremiumCard stub renders the track title so data assertions stay readable,
// wires onClick to onPlay so card clicks are testable, and marks overlay cards
// with a distinct data-testid + data-overlay so "View All" behavior can be
// asserted without importing the real (metadata-fetching) component.
vi.mock("./components/PremiumCard", () => ({
  PremiumCard: ({
    track,
    onPlay,
    isOverlayBtn,
  }: {
    track: Track;
    onPlay: () => void;
    isOverlayBtn?: boolean;
  }) => (
    <div
      data-testid={isOverlayBtn ? "premium-card-overlay" : "premium-card"}
      data-overlay={isOverlayBtn ? "true" : undefined}
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={onPlay}
    >
      {track.title}
    </div>
  ),
}));
vi.mock("./components/FullRecentView", () => ({
  FullRecentView: (props: FullRecentViewProps) =>
    mocks.FullRecentViewSpy(props),
}));

interface HomeTabProps {
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  onOpenFolder: (id: string, name: string) => void;
  token: string | null;
  userProfile?: UserProfile;
  currentTrack?: Track | null;
}

interface FullRecentViewProps {
  recent: Track[];
  title?: string;
  onBack: () => void;
  onPlay: (track: Track, ctx: Track[]) => void;
  token: string | null;
  currentTrack?: Track | null;
}

function baseProps(over: Partial<HomeTabProps> = {}): HomeTabProps {
  return {
    onPlay: () => {},
    onOpenFolder: () => {},
    token: "tok-1",
    ...over,
  };
}

function driveFile(over: Partial<DriveFileItem> = {}): DriveFileItem {
  return { id: "f-1", name: "Song.mp3", mimeType: "audio/mpeg", ...over };
}

const DRIVE_FILES_CHANGED = "drive-files-changed";

describe("HomeTab Recently Added delta sync", () => {
  beforeEach(() => {
    mocks.getRecentlyPlayed.mockResolvedValue([]);
    mocks.getHeavyRotation.mockResolvedValue([]);
    mocks.getRandomDiscoveries.mockResolvedValue([]);
    mocks.getMostVisitedFolders.mockResolvedValue([]);
    mocks.getRecentlyAddedAudioFiles.mockReset();
    mocks.captureError.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("1. fetches recently added once on mount and renders the section with tracks", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "a", name: "First.mp3" }),
    ]);
    render(<HomeTab {...baseProps()} />);

    expect(await screen.findByText("First.mp3")).toBeTruthy();
    expect(screen.getByText("Recently Added to Drive")).toBeTruthy();
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1);
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledWith("tok-1");
  });

  it("2. refetches ONLY recently added (not the whole loadData) on drive-files-changed", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "a", name: "First.mp3" }),
    ]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText("First.mp3");
    expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);

    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "b", name: "Second.mp3" }),
    ]);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DRIVE_FILES_CHANGED, { detail: { count: 1 } }),
      );
    });

    expect(await screen.findByText("Second.mp3")).toBeTruthy();
    expect(screen.queryByText("First.mp3")).toBeNull();
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
    // Delta sync must not re-run the heavy local loads.
    expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);
  });

  it("3. generation guard: stale response never overwrites the newest one (3 overlapping fetches)", async () => {
    const deferred: Array<{ resolve: (v: DriveFileItem[]) => void }> = [];
    mocks.getRecentlyAddedAudioFiles
      .mockReturnValueOnce(
        new Promise((resolve) => {
          deferred.push({ resolve });
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          deferred.push({ resolve });
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          deferred.push({ resolve });
        }),
      );
    render(<HomeTab {...baseProps()} />);
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED));
    });
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
    });
    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED));
    });
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(3);
    });

    // Newest request resolves FIRST with fresh data.
    await act(async () => {
      deferred[2].resolve([driveFile({ id: "c", name: "Newest.mp3" })]);
      await Promise.resolve();
    });
    expect(await screen.findByText("Newest.mp3")).toBeTruthy();

    // Older responses arrive later — they must be dropped, not applied.
    await act(async () => {
      deferred[1].resolve([driveFile({ id: "b", name: "Middle.mp3" })]);
      await Promise.resolve();
    });
    await act(async () => {
      deferred[0].resolve([driveFile({ id: "a", name: "Oldest.mp3" })]);
      await Promise.resolve();
    });

    expect(screen.queryByText("Middle.mp3")).toBeNull();
    expect(screen.queryByText("Oldest.mp3")).toBeNull();
    expect(screen.getByText("Newest.mp3")).toBeTruthy();
  });

  it("4. does not fetch when token is null, even after drive-files-changed", async () => {
    render(<HomeTab {...baseProps({ token: null })} />);
    await waitFor(() => {
      expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED));
    });
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(0);
    });
    expect(mocks.getRecentlyAddedAudioFiles).not.toHaveBeenCalled();
    expect(screen.queryByText("Recently Added to Drive")).toBeNull();
  });

  it("5. fetch rejection: captureError logged and previous state kept", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "a", name: "First.mp3" }),
    ]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText("First.mp3");

    mocks.getRecentlyAddedAudioFiles.mockRejectedValue(
      new Error("network down"),
    );
    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED));
    });
    await waitFor(() => {
      expect(mocks.captureError).toHaveBeenCalledTimes(1);
    });

    const errArg = mocks.captureError.mock.calls[0][0] as {
      source: string;
      level: string;
      message: string;
    };
    expect(errArg.source).toBe("HomeTab");
    expect(errArg.level).toBe("warn");
    expect(errArg.message).toContain("failed-to-load-recently-added");
    // Old data must survive a failed refetch.
    expect(screen.getByText("First.mp3")).toBeTruthy();
  });

  it("6. unmount removes the listener: firing drive-files-changed afterwards does nothing", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    const { unmount } = render(<HomeTab {...baseProps()} />);
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1);
    });

    unmount();
    const callsBefore = mocks.getRecentlyAddedAudioFiles.mock.calls.length;
    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED));
    });
    expect(mocks.getRecentlyAddedAudioFiles.mock.calls.length).toBe(
      callsBefore,
    );
  });

  it("7. recent-updated still runs the full loadData (getRecentlyPlayed re-fetches)", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    render(<HomeTab {...baseProps()} />);
    await waitFor(() => {
      expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new Event("recent-updated"));
    });
    await waitFor(() => {
      expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(2);
    });
  });

  it("8. rerender does not register duplicate drive-files-changed listeners", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    const { rerender } = render(<HomeTab {...baseProps()} />);
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1);
    });

    rerender(
      <HomeTab
        {...baseProps({
          userProfile: { name: "X", email: "x@y.z", picture: "" },
        })}
      />,
    );
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED));
    });
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
    });
    // A duplicate listener would have pushed this to 3.
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
  });

  it("9. hides the section when a refetch returns no audio files", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "a", name: "First.mp3" }),
    ]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText("First.mp3");
    expect(screen.getByText("Recently Added to Drive")).toBeTruthy();

    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED));
    });
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
    });

    expect(screen.queryByText("Recently Added to Drive")).toBeNull();
  });

  it("10. refetches recently added when pro-sync-complete fires (sync worker detected new Drive files)", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "a", name: "First.mp3" }),
    ]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText("First.mp3");
    expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);

    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "b", name: "Second.mp3" }),
    ]);
    act(() => {
      window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAMES.complete));
    });

    expect(await screen.findByText("Second.mp3")).toBeTruthy();
    expect(screen.queryByText("First.mp3")).toBeNull();
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
    // Delta sync must not re-run the heavy local loads.
    expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);
  });

  it("11. pro-sync-complete with null token does not fetch", async () => {
    render(<HomeTab {...baseProps({ token: null })} />);
    await waitFor(() => {
      expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAMES.complete));
    });
    expect(mocks.getRecentlyAddedAudioFiles).not.toHaveBeenCalled();
    expect(screen.queryByText("Recently Added to Drive")).toBeNull();
  });
});

describe("HomeTab Recently Added View All (overlay reuses Recent Files mechanism)", () => {
  beforeEach(() => {
    mocks.getRecentlyPlayed.mockResolvedValue([]);
    mocks.getHeavyRotation.mockResolvedValue([]);
    mocks.getRandomDiscoveries.mockResolvedValue([]);
    mocks.getMostVisitedFolders.mockResolvedValue([]);
    mocks.getRecentlyAddedAudioFiles.mockReset();
    mocks.captureError.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const sixRecentlyAdded = () =>
    Array.from({ length: 6 }, (_, i) =>
      driveFile({ id: `ra-${String(i)}`, name: `Track ${String(i)}.mp3` }),
    );

  it("a. last visible card is an overlay (6 > 5) and click opens full view with all 6 tracks + title", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue(sixRecentlyAdded());
    const onPlay = vi.fn();
    render(<HomeTab {...baseProps({ onPlay })} />);

    await screen.findByText("Track 4.mp3");
    // The 6th track lies beyond the visibleCount slice — must NOT render.
    expect(screen.queryByText("Track 5.mp3")).toBeNull();

    const overlayCard = screen.getByTestId("premium-card-overlay");
    expect(overlayCard.getAttribute("data-overlay")).toBe("true");
    expect(overlayCard.textContent).toContain("Track 4.mp3");
    // The overlay card must NOT trigger playback.
    expect(onPlay).not.toHaveBeenCalled();

    fireEvent.click(overlayCard);

    expect(mocks.FullRecentViewSpy).toHaveBeenCalledTimes(1);
    const props = mocks.FullRecentViewSpy.mock.calls[0][0];
    expect(props.recent.map((t: Track) => t.id)).toEqual([
      "ra-0",
      "ra-1",
      "ra-2",
      "ra-3",
      "ra-4",
      "ra-5",
    ]);
    expect(props.title).toBe("Recently Added to Drive");
    expect(typeof props.onBack).toBe("function");
    expect(props.token).toBe("tok-1");
  });

  it("b. no overlay when 3 <= 5; clicking the first card plays it with the recently-added context", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "ra-0", name: "Track 0.mp3" }),
      driveFile({ id: "ra-1", name: "Track 1.mp3" }),
      driveFile({ id: "ra-2", name: "Track 2.mp3" }),
    ]);
    const onPlay = vi.fn();
    render(<HomeTab {...baseProps({ onPlay })} />);

    await screen.findByText("Track 0.mp3");
    // 3 <= visibleCount → every card is a normal card, no overlay anywhere.
    expect(screen.queryByTestId("premium-card-overlay")).toBeNull();
    expect(screen.getAllByTestId("premium-card").length).toBe(3);

    fireEvent.click(screen.getAllByTestId("premium-card")[0]);

    expect(onPlay).toHaveBeenCalledTimes(1);
    const [track, context] = onPlay.mock.calls[0] as [Track, Track[]];
    expect(track.id).toBe("ra-0");
    expect(context.map((t: Track) => t.id)).toEqual(["ra-0", "ra-1", "ra-2"]);
    // Playback path must NOT open the full view.
    expect(mocks.FullRecentViewSpy).not.toHaveBeenCalled();
  });

  it("c. back from the full view returns to the grid", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue(sixRecentlyAdded());
    render(<HomeTab {...baseProps()} />);

    await screen.findByText("Track 4.mp3");
    fireEvent.click(screen.getByTestId("premium-card-overlay"));
    expect(mocks.FullRecentViewSpy).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.FullRecentViewSpy.mock.calls[0][0].onBack();
    });

    // Full view was rendered once; going back re-renders the grid, not the view.
    expect(mocks.FullRecentViewSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Recently Added to Drive")).toBeTruthy();
    expect(screen.getByTestId("premium-card-overlay")).toBeTruthy();
  });

  it('d. exactly 5 items (= visibleCount desktop) shows the overlay and opens full view with all 5 (contract flip: was "no overlay")', async () => {
    // Regression (a): 5 items == visibleCount means the API page was full
    // (pageSize=100 capped), so more files may exist behind it. The last card
    // must become a View All entry — previously `5 > 5` was always false, so
    // the overlay NEVER appeared with a full page on desktop.
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) =>
        driveFile({ id: `ra-${String(i)}`, name: `Track ${String(i)}.mp3` }),
      ),
    );
    render(<HomeTab {...baseProps()} />);

    await screen.findByText("Track 4.mp3");
    const overlayCard = screen.getByTestId("premium-card-overlay");
    expect(overlayCard.getAttribute("data-overlay")).toBe("true");
    expect(overlayCard.textContent).toContain("Track 4.mp3");

    fireEvent.click(overlayCard);

    expect(mocks.FullRecentViewSpy).toHaveBeenCalledTimes(1);
    const props = mocks.FullRecentViewSpy.mock.calls[0][0];
    expect(props.recent.map((t: Track) => t.id)).toEqual([
      "ra-0",
      "ra-1",
      "ra-2",
      "ra-3",
      "ra-4",
    ]);
  });

  it("e. 100 items: grid renders 5 cards, index 4 is the overlay, full view receives all 100", async () => {
    // Regression (b): the API now returns up to 100 items; the grid must
    // still slice to visibleCount and the full view must get the whole list.
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) =>
        driveFile({ id: `ra-${String(i)}`, name: `Track ${String(i)}.mp3` }),
      ),
    );
    render(<HomeTab {...baseProps()} />);

    await screen.findByText("Track 4.mp3");
    expect(screen.queryByText("Track 5.mp3")).toBeNull();
    expect(screen.getAllByTestId("premium-card").length).toBe(4);
    const overlayCard = screen.getByTestId("premium-card-overlay");
    expect(overlayCard.textContent).toContain("Track 4.mp3");

    fireEvent.click(overlayCard);

    expect(mocks.FullRecentViewSpy).toHaveBeenCalledTimes(1);
    const props = mocks.FullRecentViewSpy.mock.calls[0][0];
    expect(props.recent).toHaveLength(100);
    expect(props.recent[99].id).toBe("ra-99");
  });

  it("f. 4 items (< visibleCount): no overlay, clicking a card plays with the 4-item context (unchanged contract)", async () => {
    // Regression (c): a short list must NOT show the overlay (`4 >= 5` false),
    // and playback must keep working with the visible slice as context.
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) =>
        driveFile({ id: `ra-${String(i)}`, name: `Track ${String(i)}.mp3` }),
      ),
    );
    const onPlay = vi.fn();
    render(<HomeTab {...baseProps({ onPlay })} />);

    await screen.findByText("Track 0.mp3");
    expect(screen.queryByTestId("premium-card-overlay")).toBeNull();
    expect(screen.getAllByTestId("premium-card").length).toBe(4);

    fireEvent.click(screen.getAllByTestId("premium-card")[0]);

    expect(onPlay).toHaveBeenCalledTimes(1);
    const [track, context] = onPlay.mock.calls[0] as [Track, Track[]];
    expect(track.id).toBe("ra-0");
    expect(context.map((t: Track) => t.id)).toEqual([
      "ra-0",
      "ra-1",
      "ra-2",
      "ra-3",
    ]);
    expect(mocks.FullRecentViewSpy).not.toHaveBeenCalled();
  });

  it("g. guard: removed header View All button must not come back (3 <= visibleCount); section still renders cards", async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([
      driveFile({ id: "ra-0", name: "Track 0.mp3" }),
      driveFile({ id: "ra-1", name: "Track 1.mp3" }),
      driveFile({ id: "ra-2", name: "Track 2.mp3" }),
    ]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText("Track 0.mp3");

    // The removed header entry point must stay gone while the section renders.
    expect(screen.queryByTestId("view-all-recently-added")).toBeNull();
    // Short list still renders all cards; 3 <= visibleCount → no overlay.
    expect(screen.getAllByTestId("premium-card").length).toBe(3);
    expect(screen.queryByTestId("premium-card-overlay")).toBeNull();
  });
});

describe("HomeTab skeleton loading (null-state contract)", () => {
  beforeEach(() => {
    mocks.getRecentlyPlayed.mockReset();
    mocks.getHeavyRotation.mockReset();
    mocks.getRandomDiscoveries.mockReset();
    mocks.getMostVisitedFolders.mockReset();
    mocks.getRecentlyAddedAudioFiles.mockReset();
    mocks.captureError.mockReset();
    mocks.prefetchVisibleTracks.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const track = (over: Partial<Track> = {}): Track => ({
    id: "t-1",
    title: "Track 1",
    artist: "Artist 1",
    streamUrl: "stream://t-1",
    ...over,
  });

  const folder = (over: Partial<FolderVisitEntry> = {}): FolderVisitEntry => ({
    id: "v-1",
    name: "Folder 1",
    count: 3,
    lastVisited: Date.now(),
    ...over,
  });

  // Deferred promises keep every fetch pending until the test resolves them,
  // so the component stays in its "never loaded" (null) state on demand.
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function mockAllPending(d: {
    recent: { promise: Promise<Track[]>; resolve: (v: Track[]) => void };
    heavy: { promise: Promise<Track[]>; resolve: (v: Track[]) => void };
    discover: { promise: Promise<Track[]>; resolve: (v: Track[]) => void };
    folders: {
      promise: Promise<FolderVisitEntry[]>;
      resolve: (v: FolderVisitEntry[]) => void;
    };
    added: {
      promise: Promise<DriveFileItem[]>;
      resolve: (v: DriveFileItem[]) => void;
    };
  }) {
    mocks.getRecentlyPlayed.mockReturnValue(d.recent.promise);
    mocks.getHeavyRotation.mockReturnValue(d.heavy.promise);
    mocks.getRandomDiscoveries.mockReturnValue(d.discover.promise);
    mocks.getMostVisitedFolders.mockReturnValue(d.folders.promise);
    mocks.getRecentlyAddedAudioFiles.mockReturnValue(d.added.promise);
  }

  it("a. shows 5 section skeletons + greeting skeleton while every fetch is pending (null state)", () => {
    mockAllPending({
      recent: deferred<Track[]>(),
      heavy: deferred<Track[]>(),
      discover: deferred<Track[]>(),
      folders: deferred<FolderVisitEntry[]>(),
      added: deferred<DriveFileItem[]>(),
    });
    render(<HomeTab {...baseProps()} />);

    expect(screen.getAllByTestId("home-skeleton-section")).toHaveLength(5);
    expect(screen.getByTestId("home-greeting-skeleton")).toBeTruthy();
    expect(screen.queryByText("Recent Files")).toBeNull();
    expect(screen.queryByText("Recently Added to Drive")).toBeNull();
    expect(screen.queryByText("Heavy Rotation")).toBeNull();
    expect(screen.queryByText("home.discover")).toBeNull();
    expect(screen.queryByText("Jump Back In")).toBeNull();
  });

  it("b. resolving every fetch replaces all skeletons with real sections", async () => {
    const d = {
      recent: deferred<Track[]>(),
      heavy: deferred<Track[]>(),
      discover: deferred<Track[]>(),
      folders: deferred<FolderVisitEntry[]>(),
      added: deferred<DriveFileItem[]>(),
    };
    mockAllPending(d);
    render(<HomeTab {...baseProps()} />);
    expect(screen.getAllByTestId("home-skeleton-section")).toHaveLength(5);

    await act(async () => {
      d.recent.resolve([
        track({ id: "r1" }),
        track({ id: "r2" }),
        track({ id: "r3" }),
      ]);
      d.heavy.resolve([
        track({ id: "h1" }),
        track({ id: "h2" }),
        track({ id: "h3" }),
      ]);
      d.discover.resolve([
        track({ id: "d1" }),
        track({ id: "d2" }),
        track({ id: "d3" }),
      ]);
      d.folders.resolve([folder({ id: "v1" })]);
      d.added.resolve([
        driveFile({ id: "a1", name: "New 1.mp3" }),
        driveFile({ id: "a2", name: "New 2.mp3" }),
        driveFile({ id: "a3", name: "New 3.mp3" }),
      ]);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("home-skeleton-section")).toBeNull();
    expect(screen.queryByTestId("home-greeting-skeleton")).toBeNull();
    expect(screen.getByText("Recent Files")).toBeTruthy();
    expect(screen.getByText("Recently Added to Drive")).toBeTruthy();
    expect(screen.getByText("Heavy Rotation")).toBeTruthy();
    expect(screen.getByText("home.discover")).toBeTruthy();
    expect(screen.getByText("Jump Back In")).toBeTruthy();
    expect(screen.getAllByTestId("premium-card")).toHaveLength(12);
  });

  it("c. partial resolve: only the resolved section renders, the other four stay skeleton", async () => {
    const d = {
      recent: deferred<Track[]>(),
      heavy: deferred<Track[]>(),
      discover: deferred<Track[]>(),
      folders: deferred<FolderVisitEntry[]>(),
      added: deferred<DriveFileItem[]>(),
    };
    mockAllPending(d);
    render(<HomeTab {...baseProps()} />);

    await act(async () => {
      d.recent.resolve([
        track({ id: "r1" }),
        track({ id: "r2" }),
        track({ id: "r3" }),
      ]);
      await Promise.resolve();
    });

    expect(screen.getByText("Recent Files")).toBeTruthy();
    expect(screen.getAllByTestId("premium-card")).toHaveLength(3);
    expect(screen.getAllByTestId("home-skeleton-section")).toHaveLength(4);
    expect(screen.queryByText("Recently Added to Drive")).toBeNull();
    expect(screen.queryByText("Heavy Rotation")).toBeNull();
    expect(screen.queryByText("home.discover")).toBeNull();
    expect(screen.queryByText("Jump Back In")).toBeNull();
  });

  it("d. delta sync after a completed load never re-shows skeletons (no flicker)", async () => {
    const d = {
      recent: deferred<Track[]>(),
      heavy: deferred<Track[]>(),
      discover: deferred<Track[]>(),
      folders: deferred<FolderVisitEntry[]>(),
      added: deferred<DriveFileItem[]>(),
    };
    mockAllPending(d);
    render(<HomeTab {...baseProps()} />);

    await act(async () => {
      d.recent.resolve([
        track({ id: "r1" }),
        track({ id: "r2" }),
        track({ id: "r3" }),
      ]);
      d.heavy.resolve([]);
      d.discover.resolve([]);
      d.folders.resolve([]);
      d.added.resolve([driveFile({ id: "a1", name: "New.mp3" })]);
      await Promise.resolve();
    });
    expect(screen.queryByTestId("home-skeleton-section")).toBeNull();

    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED));
    });
    await waitFor(() => {
      expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
    });

    expect(screen.queryByTestId("home-skeleton-section")).toBeNull();
    expect(screen.queryByTestId("home-greeting-skeleton")).toBeNull();
    expect(screen.getByText("Recent Files")).toBeTruthy();
  });

  it("e. all fetches resolving to [] means truly empty: no skeleton, no section", async () => {
    const d = {
      recent: deferred<Track[]>(),
      heavy: deferred<Track[]>(),
      discover: deferred<Track[]>(),
      folders: deferred<FolderVisitEntry[]>(),
      added: deferred<DriveFileItem[]>(),
    };
    mockAllPending(d);
    render(<HomeTab {...baseProps()} />);
    expect(screen.getAllByTestId("home-skeleton-section")).toHaveLength(5);

    await act(async () => {
      d.recent.resolve([]);
      d.heavy.resolve([]);
      d.discover.resolve([]);
      d.folders.resolve([]);
      d.added.resolve([]);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("home-skeleton-section")).toBeNull();
    expect(screen.queryByTestId("home-greeting-skeleton")).toBeNull();
    expect(screen.queryByText("Recent Files")).toBeNull();
    expect(screen.queryByText("Recently Added to Drive")).toBeNull();
    expect(screen.queryByText("Heavy Rotation")).toBeNull();
    expect(screen.queryByText("home.discover")).toBeNull();
    expect(screen.queryByText("Jump Back In")).toBeNull();
  });

  it("f. prefetch effect survives the all-null state and receives exactly the resolved ids", async () => {
    const d = {
      recent: deferred<Track[]>(),
      heavy: deferred<Track[]>(),
      discover: deferred<Track[]>(),
      folders: deferred<FolderVisitEntry[]>(),
      added: deferred<DriveFileItem[]>(),
    };
    mockAllPending(d);
    render(<HomeTab {...baseProps()} />);

    // All-null state: the spread must not throw and nothing is prefetched yet.
    expect(mocks.prefetchVisibleTracks).not.toHaveBeenCalled();

    await act(async () => {
      d.recent.resolve([track({ id: "r1" }), track({ id: "r2" })]);
      await Promise.resolve();
    });

    expect(mocks.prefetchVisibleTracks).toHaveBeenCalledTimes(1);
    expect(mocks.prefetchVisibleTracks).toHaveBeenCalledWith(["r1", "r2"]);
  });

  it("g. greeting skeleton shows only while recent is null, then the real greeting replaces it", async () => {
    const d = {
      recent: deferred<Track[]>(),
      heavy: deferred<Track[]>(),
      discover: deferred<Track[]>(),
      folders: deferred<FolderVisitEntry[]>(),
      added: deferred<DriveFileItem[]>(),
    };
    mockAllPending(d);
    render(<HomeTab {...baseProps()} />);

    expect(screen.getByTestId("home-greeting-skeleton")).toBeTruthy();
    expect(screen.queryByText(/^Good (morning|afternoon|evening)/)).toBeNull();

    await act(async () => {
      d.recent.resolve([track({ id: "r1" })]);
      d.heavy.resolve([]);
      d.discover.resolve([]);
      d.folders.resolve([]);
      d.added.resolve([]);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("home-greeting-skeleton")).toBeNull();
    expect(screen.getByText(/^Good (morning|afternoon|evening)/)).toBeTruthy();
  });
});
