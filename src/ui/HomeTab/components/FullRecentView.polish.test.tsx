// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
  getTrackMetadata: vi.fn(),
}));

vi.mock("react-i18next", () => {
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

describe("mobile list polish: history screen", () => {
  it("does not render the file-count badge next to the title (title + layout stay)", () => {
    const { container } = render(
      <FullRecentView
        recent={[makeTrack("t1", "Alpha"), makeTrack("t2", "Beta")]}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        token="tok"
        title="Recently Added to Drive"
      />,
    );
    // Title must survive the badge removal.
    expect(screen.getByText("Recently Added to Drive")).toBeTruthy();
    // The badge was the only span.rounded-full pill in the header (the menu
    // trigger is a button, not a span) — it must be gone entirely.
    expect(container.querySelector("span.rounded-full")).toBeNull();
  });

  it("renders the search input + sort dropdown normally after the CSS-only header fix", () => {
    const { container } = render(
      <FullRecentView
        recent={[makeTrack("t1", "Alpha")]}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        token="tok"
        title="Recently Added to Drive"
      />,
    );
    const input = screen.getByRole("textbox");
    expect(input).toBeTruthy();
    // Narrow base width so a 360px viewport cannot overflow; sm+ keeps room.
    expect(input.className).toContain("w-28");
    expect(input.className).toContain("sm:w-56");
    // SortDropdown trigger (listbox) still renders beside the search.
    expect(container.querySelector('[aria-haspopup="listbox"]')).not.toBeNull();
  });

  it("header row wraps and the right group can shrink (no overflow at 360px)", () => {
    render(
      <FullRecentView
        recent={[makeTrack("t1", "Alpha")]}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        token="tok"
        title="Recently Added to Drive"
      />,
    );
    const input = screen.getByRole("textbox");
    const header = input.closest("div.justify-between");
    expect(header).not.toBeNull();
    // Why flex-wrap: at 360px the title + search/sort row would otherwise
    // overflow horizontally — wrapping drops the controls to a second line.
    expect(header?.className).toContain("flex-wrap");
    const rightGroup = input.closest("div.shrink-0");
    expect(rightGroup).not.toBeNull();
    // Why min-w-0: without it the flex item refuses to shrink below the
    // input's intrinsic width and pushes past the viewport edge.
    expect(rightGroup?.className).toContain("min-w-0");
  });
});
