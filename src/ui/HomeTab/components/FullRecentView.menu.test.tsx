// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { FullRecentView } from "./FullRecentView";
import en from "../../../locales/en/translation.json";
import type { Track } from "../../../types";

const mocks = vi.hoisted(() => ({
  driveApi: {
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
  },
  db: {
    files: { delete: vi.fn(), update: vi.fn() },
  },
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
  getPlaylists: vi.fn(),
  addTrackToPlaylist: vi.fn(),
  getTrackMetadata: vi.fn(),
}));

vi.mock("react-i18next", () => {
  // Resolve keys against the real en resources so assertions read the
  // shipped copy instead of hard-coded fallbacks.
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string) => resolveKey(key) ?? fallback ?? key,
    }),
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: i,
        size: 92,
        start: i * 92,
      })),
    getTotalSize: () => count * 92,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
    containerRef: { current: document.createElement("div") },
  })),
}));

vi.mock("../../../utils/streamPrefetcher", () => ({
  prefetchVisibleTracks: vi.fn(),
}));

vi.mock("../../../utils/metadata", () => ({
  getTrackMetadata: mocks.getTrackMetadata,
}));

vi.mock("../../../utils/driveApi", () => mocks.driveApi);
vi.mock("../../../db/db", () => ({ db: mocks.db }));
vi.mock("../../../utils/errorLog", () => ({
  captureError: mocks.captureError,
}));
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../../utils/playlists", () => ({
  getPlaylists: mocks.getPlaylists,
  addTrackToPlaylist: mocks.addTrackToPlaylist,
}));

function makeTrack(id: string, title: string): Track {
  return {
    id,
    title,
    artist: "Artist",
    streamUrl: "",
    parentId: "parent-1",
    parentName: "Folder One",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPlaylists.mockResolvedValue([]);
  mocks.driveApi.deleteFile.mockResolvedValue({
    id: "t1",
    name: "x",
    mimeType: "audio/mpeg",
    trashed: true,
    isFolder: false,
    parentId: "p",
  });
  mocks.getTrackMetadata.mockResolvedValue({
    title: "",
    artist: null,
    duration: 0,
    size: 0,
    pictureData: null,
    pictureFormat: undefined,
  });
});

afterEach(() => {
  cleanup();
});

function renderRecent(tracks: Track[]) {
  return render(
    <FullRecentView
      recent={tracks}
      onBack={vi.fn()}
      onPlay={vi.fn()}
      token="tok"
    />,
  );
}

describe("FullRecentView title prop", () => {
  it('defaults to "Recent Files" when title is not provided', () => {
    renderRecent([makeTrack("t1", "Alpha")]);
    const span = screen.getByText("Recent Files");
    expect(span).toBeTruthy();
    expect(span.getAttribute("title")).toBe("Recent Files");
  });

  it("renders the provided title (Recently Added to Drive path)", () => {
    render(
      <FullRecentView
        recent={[makeTrack("t1", "Alpha")]}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        token="tok"
        title="Recently Added to Drive"
      />,
    );
    const span = screen.getByText("Recently Added to Drive");
    expect(span).toBeTruthy();
    expect(span.getAttribute("title")).toBe("Recently Added to Drive");
  });
});

describe("FullRecentView menu delete flow", () => {
  it("shows the 3-dot menu on each recent track card (hideMenu removed)", () => {
    renderRecent([makeTrack("t1", "Alpha"), makeTrack("t2", "Beta")]);
    const triggers = document.querySelectorAll('[aria-haspopup="menu"]');
    expect(triggers.length).toBe(2);
  });

  it("recent menu shows exactly the curated items (no Select Multiple / Move to)", () => {
    renderRecent([makeTrack("t1", "Alpha")]);
    const trigger = document.querySelector(
      '[aria-haspopup="menu"]',
    ) as HTMLButtonElement;
    fireEvent.click(trigger);
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    const names = Array.from(menu.querySelectorAll("button")).map(
      (b) => b.textContent?.trim() ?? "",
    );
    expect(names.sort()).toEqual([
      "Add to Playlist",
      "Delete",
      "Download Song",
      "Locate File",
    ]);
  });

  it("deleting a track removes it from the visible list (local removal)", async () => {
    renderRecent([makeTrack("t1", "Alpha"), makeTrack("t2", "Beta")]);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();

    const trigger = document.querySelector(
      '[aria-haspopup="menu"]',
    ) as HTMLButtonElement;
    fireEvent.click(trigger);
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    fireEvent.click(
      Array.from(menu.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Delete",
      ) as HTMLButtonElement,
    );
    expect(screen.getByText("Move to Trash?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(mocks.driveApi.deleteFile).toHaveBeenCalledWith("tok", "t1");
    });
    await waitFor(() => {
      expect(mocks.db.files.delete).toHaveBeenCalledWith("t1");
    });
    await waitFor(() => {
      expect(screen.queryByText("Alpha")).toBeNull();
    });
    expect(screen.getByText("Beta")).toBeTruthy();
  });
});

describe("FullRecentView now-playing highlight (currentTrack prop)", () => {
  afterEach(() => {
    cleanup();
  });

  const cardByTitle = (title: string): HTMLDivElement | null => {
    const cards = document.querySelectorAll<HTMLDivElement>(".p-3");
    return (
      Array.from(cards).find((c) => c.textContent?.includes(title)) ?? null
    );
  };

  it("marks only the track matching currentTrack.id as playing (hover-like gray, blue title)", () => {
    const tracks = [makeTrack("t1", "Alpha"), makeTrack("t2", "Beta")];
    render(
      <FullRecentView
        recent={tracks}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        token="tok"
        currentTrack={tracks[0]}
      />,
    );
    const alpha = cardByTitle("Alpha");
    const beta = cardByTitle("Beta");
    expect(alpha).not.toBeNull();
    expect(alpha?.className).toContain("bg-gray-100 dark:bg-[#2a2b2f]");
    expect(alpha?.className).not.toContain("bg-brand-primary/10");
    expect(alpha?.querySelector("h3")?.className).toContain(
      "text-brand-primary!",
    );
    expect(beta?.className).not.toContain("bg-gray-100 dark:bg-[#2a2b2f]");
    expect(beta?.querySelector("h3")?.className).not.toContain(
      "text-brand-primary!",
    );
  });

  it("leaves every card idle when currentTrack is null/undefined", () => {
    const tracks = [makeTrack("t1", "Alpha")];
    render(
      <FullRecentView
        recent={tracks}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        token="tok"
      />,
    );
    const alpha = cardByTitle("Alpha");
    expect(alpha?.className).not.toContain("bg-gray-100 dark:bg-[#2a2b2f]");
    expect(alpha?.querySelector("h3")?.className).not.toContain(
      "text-brand-primary!",
    );
  });
});
