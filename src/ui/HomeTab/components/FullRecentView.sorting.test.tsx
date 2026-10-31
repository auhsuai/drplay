// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FullRecentView, sortRecentTracks } from "./FullRecentView";
import en from "../../../locales/en/translation.json";
import type { Track } from "../../../types";
import type { RecentItem } from "../recentView";

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
  // The mock surfaces the two cells the header must align with: the item id
  // (order assertions) and the Date cell content (real-date display). The
  // date format mirrors SongCard's formatModifiedDate (locale day-first,
  // 2-digit, "—" for missing/malformed) without importing the real component
  // (whose metadata/effect deps are out of this slice's scope).
  SongCard: ({ item }: { item: { id: string; modifiedTime?: string } }) => {
    let dateText = "—";
    if (item.modifiedTime) {
      const parsed = new Date(item.modifiedTime);
      if (!Number.isNaN(parsed.getTime())) {
        dateText = parsed.toLocaleDateString(undefined, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
      }
    }
    return (
      <div data-testid="song-card" data-item-id={item.id}>
        <span data-testid="card-date">{dateText}</span>
      </div>
    );
  },
}));

function makeTrack(id: string, title: string, size?: number): Track {
  return { id, title, artist: "", streamUrl: "", size };
}

// RecentItem = Track + optional real view date (epoch ms) — see recentView.ts.
function makeDated(
  id: string,
  title: string,
  viewDate?: number,
  size?: number,
): RecentItem {
  return { id, title, artist: "", streamUrl: "", size, viewDate };
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

  it('sorts oldest-first for "modifiedTime" (real viewDate, asc)', () => {
    const input = [
      makeDated("new", "Newest", 300),
      makeDated("mid", "Middle", 200),
      makeDated("old", "Oldest", 100),
    ];
    expect(sortRecentTracks(input, "modifiedTime").map((t) => t.id)).toEqual([
      "old",
      "mid",
      "new",
    ]);
  });

  it('sorts newest-first for "modifiedTime desc" (real viewDate, desc = default Date)', () => {
    const input = [
      makeDated("old", "Oldest", 100),
      makeDated("mid", "Middle", 200),
      makeDated("new", "Newest", 300),
    ];
    expect(
      sortRecentTracks(input, "modifiedTime desc").map((t) => t.id),
    ).toEqual(["new", "mid", "old"]);
  });

  it("pins tracks without a viewDate to the bottom in both date directions", () => {
    const input = [
      makeDated("none", "No Date"),
      makeDated("new", "Newest", 300),
      makeDated("old", "Oldest", 100),
      makeDated("none2", "No Date 2"),
    ];
    const asc = sortRecentTracks(input, "modifiedTime").map((t) => t.id);
    expect(asc.slice(0, 2)).toEqual(["old", "new"]);
    expect(asc.slice(2).sort()).toEqual(["none", "none2"]);
    const desc = sortRecentTracks(input, "modifiedTime desc").map((t) => t.id);
    expect(desc.slice(0, 2)).toEqual(["new", "old"]);
    expect(desc.slice(2).sort()).toEqual(["none", "none2"]);
  });

  it("keeps relative order among date-less tracks and across equal dates", () => {
    const input = [
      makeDated("n1", "No Date 1"),
      makeDated("d1", "Dated", 200),
      makeDated("n2", "No Date 2"),
      makeDated("d2", "Dated 2", 200),
    ];
    const asc = sortRecentTracks(input, "modifiedTime").map((t) => t.id);
    expect(asc).toEqual(["d1", "d2", "n1", "n2"]);
    const desc = sortRecentTracks(input, "modifiedTime desc").map((t) => t.id);
    expect(desc).toEqual(["d1", "d2", "n1", "n2"]);
  });

  it("falls back to array-order recency when NO track has a date (desc = newest-first)", () => {
    const input = [
      makeTrack("new", "Newest"),
      makeTrack("mid", "Middle"),
      makeTrack("old", "Oldest"),
    ];
    expect(
      sortRecentTracks(input, "modifiedTime desc").map((t) => t.id),
    ).toEqual(["new", "mid", "old"]);
    expect(sortRecentTracks(input, "modifiedTime").map((t) => t.id)).toEqual([
      "old",
      "mid",
      "new",
    ]);
  });

  it("keeps the newest-first array order for unknown sort options (default = desc)", () => {
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

describe("FullRecentView sort UI (FileListHeader columns)", () => {
  afterEach(() => {
    cleanup();
  });

  function renderRecent(tracks: RecentItem[]) {
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

  const headerButton = (name: string) => screen.getByRole("button", { name });

  it("renders cards in newest-first input order by default with active Date column", () => {
    renderRecent([
      makeDated("new", "Newest", 300),
      makeDated("mid", "Middle", 200),
      makeDated("old", "Oldest", 100),
    ]);
    expect(cardOrder()).toEqual(["new", "mid", "old"]);
    // Default sortOption "modifiedTime desc": Date column active descending
    // with exactly one indicator; other columns inert.
    expect(
      screen.getByRole("columnheader", { name: "Last played" }),
    ).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "none",
    );
    expect(screen.getByRole("columnheader", { name: "Size" })).toHaveAttribute(
      "aria-sort",
      "none",
    );
    expect(
      document.querySelectorAll(".bg-brand-primary.rounded-full"),
    ).toHaveLength(1);
  });

  it("names the search input for assistive tech", () => {
    renderRecent([makeDated("a", "Alpha", 100)]);
    expect(screen.getByRole("textbox", { name: "Search..." })).toBeTruthy();
  });

  it("renders exactly 3 sortable column headers", () => {
    renderRecent([makeDated("a", "Alpha", 100)]);
    expect(headerButton("Name")).toBeTruthy();
    expect(headerButton("Last played")).toBeTruthy();
    expect(headerButton("Size")).toBeTruthy();
  });

  it("click Size (inactive) applies largest-first default: size desc", async () => {
    renderRecent([
      makeDated("a", "Alpha", 100, 50),
      makeDated("b", "Bravo"),
      makeDated("c", "Charlie", 100, 10),
    ]);
    const user = userEvent.setup();
    await user.click(headerButton("Size"));
    expect(cardOrder()).toEqual(["a", "c", "b"]);
    expect(screen.getByRole("columnheader", { name: "Size" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("click Size again (active desc) toggles to ascending", async () => {
    renderRecent([
      makeDated("a", "Alpha", 100, 50),
      makeDated("b", "Bravo"),
      makeDated("c", "Charlie", 100, 10),
    ]);
    const user = userEvent.setup();
    await user.click(headerButton("Size"));
    expect(cardOrder()).toEqual(["a", "c", "b"]);
    await user.click(headerButton("Size"));
    expect(cardOrder()).toEqual(["c", "a", "b"]);
    expect(screen.getByRole("columnheader", { name: "Size" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("click Name (inactive) applies A-Z default, click again toggles Z-A", async () => {
    renderRecent([
      makeDated("b", "Bravo", 100),
      makeDated("a", "Alpha", 200),
      makeDated("c", "Charlie", 300),
    ]);
    const user = userEvent.setup();
    await user.click(headerButton("Name"));
    expect(cardOrder()).toEqual(["a", "b", "c"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await user.click(headerButton("Name"));
    expect(cardOrder()).toEqual(["c", "b", "a"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("click Date (active desc default) toggles to oldest-first, click again restores", async () => {
    renderRecent([
      makeDated("new", "Newest", 300),
      makeDated("mid", "Middle", 200),
      makeDated("old", "Oldest", 100),
    ]);
    const user = userEvent.setup();
    await user.click(headerButton("Last played"));
    expect(cardOrder()).toEqual(["old", "mid", "new"]);
    expect(
      screen.getByRole("columnheader", { name: "Last played" }),
    ).toHaveAttribute("aria-sort", "ascending");
    await user.click(headerButton("Last played"));
    expect(cardOrder()).toEqual(["new", "mid", "old"]);
    expect(
      screen.getByRole("columnheader", { name: "Last played" }),
    ).toHaveAttribute("aria-sort", "descending");
  });

  it("click Date while Name is active applies newest-first (inactive Date default desc)", async () => {
    renderRecent([
      makeDated("new", "Alpha", 300),
      makeDated("mid", "Beta", 200),
      makeDated("old", "Gamma", 100),
    ]);
    const user = userEvent.setup();
    await user.click(headerButton("Name"));
    expect(cardOrder()).toEqual(["new", "mid", "old"]);
    await user.click(headerButton("Last played"));
    expect(cardOrder()).toEqual(["new", "mid", "old"]);
    expect(
      screen.getByRole("columnheader", { name: "Last played" }),
    ).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("sorts by real viewDate (not array position) after the default view", () => {
    // Array order = oldest first; real dates say "d" is newest.
    renderRecent([
      makeDated("o1", "Old 1", 100),
      makeDated("o2", "Old 2", 200),
      makeDated("d", "Dated", 300),
    ]);
    expect(cardOrder()).toEqual(["d", "o2", "o1"]);
  });

  it("applies search filter first, then sort (filtered-out tracks stay gone)", async () => {
    renderRecent([
      makeDated("x", "Zen", 100),
      makeDated("y", "Alpha", 200),
      makeDated("z", "Zulu", 300),
    ]);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search..."), "z");
    expect(cardOrder()).toEqual(["z", "x"]);
    await user.click(headerButton("Name"));
    expect(cardOrder()).toEqual(["x", "z"]);
    expect(screen.getAllByTestId("song-card")).toHaveLength(2);
  });

  it("matches Vietnamese titles diacritics-insensitively in search", async () => {
    renderRecent([
      makeDated("noi", "Nỗi buồn", 100),
      makeDated("zen", "Zen", 200),
    ]);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search..."), "noi");
    expect(cardOrder()).toEqual(["noi"]);
  });

  it("renders zero items on an empty list without crashing (header still present)", () => {
    renderRecent([]);
    expect(screen.queryAllByTestId("song-card").length).toBe(0);
    expect(headerButton("Name")).toBeTruthy();
    expect(headerButton("Last played")).toBeTruthy();
    expect(headerButton("Size")).toBeTruthy();
  });

  it("date-less tracks pin to the bottom of the Date sort in both directions", async () => {
    renderRecent([
      makeDated("none", "No Date"),
      makeDated("new", "Newest", 300),
      makeDated("old", "Oldest", 100),
    ]);
    expect(cardOrder()).toEqual(["new", "old", "none"]);
    const user = userEvent.setup();
    await user.click(headerButton("Last played"));
    expect(cardOrder()).toEqual(["old", "new", "none"]);
  });

  it("shows the real date per row via the SongCard Date cell (both label variants)", () => {
    // Recent Files view (no title prop): "Last played" header, createdAt date.
    // (Local-time rendering: 2024-12-31T16:00Z = 01/01/2025 in Asia/Saigon CI.)
    renderRecent([makeDated("t1", "Song One", 1735689600000)]);
    expect(screen.getByText("Last played")).toBeTruthy();
    expect(screen.getByTestId("card-date").textContent).toBe("01/01/2025");
  });

  it("Recently Added view (title prop) keeps the 'Date modified' label", () => {
    render(
      <FullRecentView
        recent={[makeDated("t1", "Song One", 1735689600000)]}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        token="token"
        title="Recently Added to Drive"
      />,
    );
    expect(screen.getByText("Date modified")).toBeTruthy();
    expect(screen.queryByText("Last played")).toBeNull();
    expect(screen.getByTestId("card-date").textContent).toBe("01/01/2025");
  });

  it("rows without a date render the em-dash placeholder in the Date cell", () => {
    renderRecent([makeDated("t1", "Song One")]);
    expect(screen.getByTestId("card-date").textContent).toBe("—");
  });
});

describe("FullRecentView search clear + empty states (P2-11-1 / P2-11-4)", () => {
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

  it("clear search button has an accessible name and resets the query", async () => {
    renderRecent([makeTrack("a", "Alpha")]);
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText("Search...");
    await user.type(input, "alp");
    expect((input as HTMLInputElement).value).toBe("alp");

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("shows the no-results message when a search matches nothing", async () => {
    renderRecent([makeTrack("a", "Alpha")]);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Search..."), "zzz");

    expect(screen.getByText("No matching songs found.")).toBeTruthy();
    expect(screen.queryAllByTestId("song-card").length).toBe(0);
  });

  it("shows the empty-list message when there are no tracks and no search", () => {
    renderRecent([]);
    expect(screen.getByText("No audio files here.")).toBeTruthy();
  });
});
