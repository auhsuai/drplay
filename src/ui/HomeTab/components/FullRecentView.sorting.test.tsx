// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FullRecentView, sortRecentTracks } from "./FullRecentView";
import en from "../../../locales/en/translation.json";
import type { Track } from "../../../types";

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so we stub useTranslation to return
// the defaultValue passed to t().
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
      t: (key: string, defaultValue?: string) =>
        resolveKey(key) ?? defaultValue ?? key,
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

vi.mock("../../MainContent/components/SongCard", () => ({
  SongCard: ({ item }: { item: { id: string } }) => (
    <div data-testid="song-card" data-item-id={item.id} />
  ),
}));

function makeTrack(id: string, title: string, size?: number): Track {
  return { id, title, artist: "", streamUrl: "", size };
}

const SORT_OPTIONS = [
  "name",
  "name desc",
  "modifiedTime",
  "modifiedTime desc",
  "size",
  "size desc",
];

describe("sortRecentTracks", () => {
  it('sorts A-Z by title for "name"', () => {
    const input = [
      makeTrack("b", "Bravo"),
      makeTrack("a", "Alpha"),
      makeTrack("c", "Charlie"),
    ];
    expect(sortRecentTracks(input, "name").map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it('sorts Z-A for "name desc"', () => {
    const input = [
      makeTrack("a", "Alpha"),
      makeTrack("c", "Charlie"),
      makeTrack("b", "Bravo"),
    ];
    expect(sortRecentTracks(input, "name desc").map((t) => t.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it('keeps relative order for duplicate titles ("name")', () => {
    const input = [
      makeTrack("x1", "Song"),
      makeTrack("m", "Middle"),
      makeTrack("x3", "Song"),
    ];
    const out = sortRecentTracks(input, "name").map((t) => t.id);
    expect(out.indexOf("x1")).toBeLessThan(out.indexOf("x3"));
  });

  it("handles Vietnamese diacritic titles without crashing, deterministically", () => {
    const input = [
      makeTrack("e", "Én"),
      makeTrack("a", "An"),
      makeTrack("b", "Bà"),
    ];
    const out = sortRecentTracks(input, "name").map((t) => t.title);
    const reference = [...out].sort((x, y) => x.localeCompare(y));
    expect(out).toEqual(reference);
  });

  it("sorts by size ascending with undefined size always last", () => {
    const input = [
      makeTrack("big", "Big", 1000),
      makeTrack("none", "None"),
      makeTrack("small", "Small", 10),
    ];
    expect(sortRecentTracks(input, "size").map((t) => t.id)).toEqual([
      "small",
      "big",
      "none",
    ]);
  });

  it("sorts by size descending with undefined size always last", () => {
    const input = [
      makeTrack("small", "Small", 10),
      makeTrack("none", "None"),
      makeTrack("big", "Big", 1000),
    ];
    expect(sortRecentTracks(input, "size desc").map((t) => t.id)).toEqual([
      "big",
      "small",
      "none",
    ]);
  });

  it("keeps stable order when every track has undefined size (both directions)", () => {
    const input = [
      makeTrack("a", "Alpha"),
      makeTrack("b", "Bravo"),
      makeTrack("c", "Charlie"),
    ];
    expect(sortRecentTracks(input, "size").map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(sortRecentTracks(input, "size desc").map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it('keeps newest-first order for "modifiedTime"', () => {
    const input = [
      makeTrack("new", "Newest"),
      makeTrack("mid", "Middle"),
      makeTrack("old", "Oldest"),
    ];
    expect(sortRecentTracks(input, "modifiedTime").map((t) => t.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it('reverses to oldest-first for "modifiedTime desc"', () => {
    const input = [
      makeTrack("new", "Newest"),
      makeTrack("mid", "Middle"),
      makeTrack("old", "Oldest"),
    ];
    expect(
      sortRecentTracks(input, "modifiedTime desc").map((t) => t.id),
    ).toEqual(["old", "mid", "new"]);
  });

  it("keeps the given order for unknown sort options (default = recency)", () => {
    const input = [makeTrack("a", "Alpha"), makeTrack("b", "Bravo")];
    expect(sortRecentTracks(input, "recent").map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);
    expect(sortRecentTracks(input, "bogus").map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("does not crash on an empty list for any sort option", () => {
    for (const opt of SORT_OPTIONS) {
      expect(sortRecentTracks([], opt)).toEqual([]);
    }
  });

  it("does not mutate the input array", () => {
    const input = [makeTrack("b", "Bravo"), makeTrack("a", "Alpha")];
    sortRecentTracks(input, "name");
    expect(input.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("FullRecentView sort UI", () => {
  afterEach(() => {
    cleanup();
  });

  function renderRecent(tracks: Track[]) {
    render(
      <FullRecentView
        recent={tracks}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        token="token"
      />,
    );
  }

  const cardOrder = () =>
    screen
      .getAllByTestId("song-card")
      .map((el) => el.getAttribute("data-item-id"));

  const openSortMenu = async () => {
    const user = userEvent.setup();
    const arrow = screen.getByTitle("Toggle order");
    await user.click(arrow.parentElement as HTMLElement);
  };

  const clickSortOption = async (label: string) => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: label }));
  };

  it("renders cards in newest-first input order by default with Date label", () => {
    renderRecent([
      makeTrack("new", "Newest"),
      makeTrack("mid", "Middle"),
      makeTrack("old", "Oldest"),
    ]);
    expect(cardOrder()).toEqual(["new", "mid", "old"]);
    expect(screen.getAllByText("Date").length).toBeGreaterThan(0);
  });

  it("shows exactly 3 sort options in the menu (A-Z / Date / Size)", async () => {
    renderRecent([makeTrack("a", "Alpha")]);
    await openSortMenu();
    const menu = document.querySelector(".w-32") as HTMLElement;
    const labels = Array.from(menu.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels.sort()).toEqual(["A-Z", "Date", "Size"]);
  });

  it("sorts by size ascending (undefined last) when Size is chosen", async () => {
    renderRecent([
      makeTrack("a", "Alpha", 50),
      makeTrack("b", "Bravo"),
      makeTrack("c", "Charlie", 10),
    ]);
    await openSortMenu();
    await clickSortOption("Size");
    expect(cardOrder()).toEqual(["c", "a", "b"]);
  });

  it("sorts A-Z when A-Z is chosen", async () => {
    renderRecent([
      makeTrack("b", "Bravo"),
      makeTrack("a", "Alpha"),
      makeTrack("c", "Charlie"),
    ]);
    await openSortMenu();
    await clickSortOption("A-Z");
    expect(cardOrder()).toEqual(["a", "b", "c"]);
  });

  it("keeps newest-first order when Date is chosen (default recency behavior)", async () => {
    renderRecent([
      makeTrack("new", "Newest"),
      makeTrack("mid", "Middle"),
      makeTrack("old", "Oldest"),
    ]);
    await openSortMenu();
    await clickSortOption("Date");
    expect(cardOrder()).toEqual(["new", "mid", "old"]);
  });

  it("arrow toggle flips asc/desc repeatedly without opening the menu", async () => {
    renderRecent([
      makeTrack("new", "Newest"),
      makeTrack("mid", "Middle"),
      makeTrack("old", "Oldest"),
    ]);
    const user = userEvent.setup();
    const arrow = screen.getByTitle("Toggle order");
    await user.click(arrow);
    expect(cardOrder()).toEqual(["old", "mid", "new"]);
    expect(screen.queryByRole("button", { name: "A-Z" })).toBeNull();
    await user.click(arrow);
    expect(cardOrder()).toEqual(["new", "mid", "old"]);
  });

  it("applies search filter first, then sort", async () => {
    renderRecent([
      makeTrack("x", "Zulu"),
      makeTrack("y", "Alpha"),
      makeTrack("z", "Zen"),
    ]);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search..."), "z");
    expect(cardOrder()).toEqual(["x", "z"]);
    await openSortMenu();
    await clickSortOption("A-Z");
    expect(cardOrder()).toEqual(["z", "x"]);
  });

  it("matches Vietnamese titles diacritics-insensitively in search", async () => {
    renderRecent([makeTrack("noi", "Nỗi buồn"), makeTrack("zen", "Zen")]);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search..."), "noi");
    expect(cardOrder()).toEqual(["noi"]);
  });

  it("renders zero items on an empty list without crashing", async () => {
    renderRecent([]);
    expect(screen.queryAllByTestId("song-card").length).toBe(0);
    await openSortMenu();
    const menu = document.querySelector(".w-32") as HTMLElement;
    expect(menu.querySelectorAll("button").length).toBe(3);
  });
});
