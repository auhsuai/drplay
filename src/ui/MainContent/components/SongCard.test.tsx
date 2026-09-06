// @vitest-environment jsdom
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import { SongCard } from "./SongCard";
import { getTrackMetadata } from "../../../utils/metadata";
import type { MockInstance } from "vitest";
import type { DriveItem } from "../../../types";

vi.mock("../../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
}));

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so stub useTranslation to return the
// fallback passed to t(), matching every other component test in the repo.
// initReactI18next is stubbed too: the real src/i18n module (pulled in
// transitively via MoreMenu → playlists) calls i18n.use(initReactI18next),
// which i18next would reject with "passing an undefined module" otherwise.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const mockedFetch = vi.mocked(getTrackMetadata);

function makeItem(over: Partial<DriveItem> = {}): DriveItem {
  return {
    id: "track-1",
    title: "My Song",
    isFolder: false,
    trackInfo: {
      id: "track-1",
      title: "My Song",
      artist: "",
      streamUrl: "",
      size: 1000,
      originalName: "my song.mp3",
    },
    ...over,
  };
}

const baseProps = {
  onPlay: () => {},
  onOpenFolder: () => {},
  token: "tok",
  currentFolderId: "root",
  currentFolderName: "Root",
  folderHistory: [],
  onRefresh: () => {},
};

describe("SongCard metadata fetch", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("self-fetches on mount and falls back to the music icon when metadata has no picture", async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    // SongCard debounces the metadata fetch by 150ms (visible-card guard in
    // SongCard.tsx), so the fetch assertion must wait for the timer.
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      "track-1",
      "tok",
      1000,
      "my song.mp3",
      expect.any(Object),
    );
    await screen.findByText("Fetched Title");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
  });

  it("re-fetches metadata on remount (no cross-mount cover cache)", async () => {
    const { unmount } = render(<SongCard {...baseProps} item={makeItem()} />);
    await screen.findByText("Fetched Title");

    unmount();
    cleanup();
    mockedFetch.mockClear();

    const { container: container2 } = render(
      <SongCard {...baseProps} item={makeItem()} />,
    );
    await screen.findByText("Fetched Title");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(container2.querySelector("img")).toBeNull();
  });

  it("does not self-fetch for folder items", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({ isFolder: true, trackInfo: undefined })}
      />,
    );
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(container.querySelector(".lucide-folder")).not.toBeNull();
  });

  it("non-folder without trackInfo: click is a no-op instead of crashing", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({ trackInfo: undefined })}
        onPlay={onPlay}
      />,
    );
    const card = container.querySelector(".cursor-pointer");
    expect(card).not.toBeNull();
    expect(() => fireEvent.click(card as Element)).not.toThrow();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("metadata-updated event for this fileId triggers a re-fetch that updates the title", async () => {
    mockedFetch.mockResolvedValue({
      title: "Updated Title",
      artist: "Updated Artist",
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    render(<SongCard {...baseProps} item={makeItem()} />);
    await screen.findByText("Updated Title");
    mockedFetch.mockClear();
    mockedFetch.mockResolvedValue({
      title: "Re-fetched Title",
      artist: "Re-fetched Artist",
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    window.dispatchEvent(
      new CustomEvent("metadata-updated", { detail: { fileId: "track-1" } }),
    );
    await screen.findByText("Re-fetched Title");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("re-renders on same-id item change (trackInfo.queueItemId) so click uses fresh track (stale-prop fix)", () => {
    const onPlay = vi.fn();
    const { rerender, container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({
          trackInfo: {
            ...makeItem().trackInfo,
            queueItemId: "q-1",
          } as NonNullable<DriveItem["trackInfo"]>,
        })}
        onPlay={onPlay}
      />,
    );
    rerender(
      <SongCard
        {...baseProps}
        item={makeItem({
          trackInfo: {
            ...makeItem().trackInfo,
            queueItemId: "q-2",
          } as NonNullable<DriveItem["trackInfo"]>,
        })}
        onPlay={onPlay}
      />,
    );
    const card = container.querySelector(".cursor-pointer");
    expect(card).not.toBeNull();
    fireEvent.click(card as Element);
    expect(onPlay).toHaveBeenCalledTimes(1);
    const firstCall = onPlay.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected onPlay call");
    expect((firstCall[0] as { queueItemId: string }).queueItemId).toBe("q-2");
  });
});

describe("SongCard blob cover URL (picture bytes, no drplay://)", () => {
  // jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both are
  // undefined at runtime) — install observable spies so the blob URL contract
  // ("the cover renders straight from the picture bytes metadata") can be
  // asserted.
  beforeAll(() => {
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
  });

  let createObjectURLSpy: MockInstance<(obj: Blob | MediaSource) => string>;
  let revokeObjectURLSpy: MockInstance<(url: string) => void>;

  function metadataWithPicture(): never {
    return {
      title: "Fetched Title",
      artist: "Fetched Artist",
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureFormat: "image/png",
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue(metadataWithPicture());
    createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-songcard-cover");
    revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  async function flushMicrotasks() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders the cover from a blob URL built with the picture bytes (lazy + async decoding, fixed 48px slot)", async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    // Fixed slot (w-12 h-12 = 48px): explicit width/height reserve the box,
    // preventing CLS while the blob bytes load (web.dev CLS guidance).
    expect(img.getAttribute("width")).toBe("48");
    expect(img.getAttribute("height")).toBe("48");
    expect(container.querySelector(".lucide-music")).toBeNull();
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it("drops to the Music icon when the blob image errors (corrupt bytes — no retry chain)", async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("Fetched Title");
    expect(img.getAttribute("src")).toBe("blob:mock-songcard-cover");

    expect(() => fireEvent.error(img)).not.toThrow();

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the Music icon directly when metadata has no picture bytes (no blob URL)", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      duration: 0,
      size: 0,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    await screen.findByText("Fetched Title");

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it("prefers the full-resolution picture (pictureDataFull) over the thumb for the blob", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureDataFull: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      pictureFormat: "image/jpeg",
    } as never);
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(img.getAttribute("src")).toMatch(/^blob:/);
    // The blob must be built from the FULL bytes (8), not the thumb (4) —
    // the card cover quality fix is about WHICH byte set feeds the blob.
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.size).toBe(8);
    expect(blobArg.type).toBe("image/jpeg");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".lucide-music")).toBeNull();
  });

  it("falls back to the thumb bytes when pictureDataFull is null", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureDataFull: null,
      pictureFormat: "image/png",
    } as never);
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(img.getAttribute("src")).toMatch(/^blob:/);
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.size).toBe(4);
    expect(blobArg.type).toBe("image/png");
    expect(container.querySelector(".lucide-music")).toBeNull();
  });

  it("creates exactly one blob URL from the picture bytes and never revokes it", async () => {
    const { unmount } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("Fetched Title");
    expect(img.getAttribute("src")).toBe("blob:mock-songcard-cover");
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe("image/png");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);

    unmount();
    await flushMicrotasks();

    // The blob is intentionally never revoked (covers are small; the browser
    // drops blob URLs on page unload).
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });
});

describe("SongCard keyboard accessibility (WCAG 2.1.1 Keyboard / WAI-ARIA APG button pattern)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('card is an accessible button: role="button" + tabIndex=0', () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const card = container.querySelector(".cursor-pointer");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("button");
    expect(card?.getAttribute("tabindex")).toBe("0");
  });

  it("Enter on the card activates like a click (track → onPlay)", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} onPlay={onPlay} />,
    );
    const card = container.querySelector(".cursor-pointer") as Element;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onPlay).toHaveBeenCalledTimes(1);
    const firstCall = onPlay.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected onPlay call");
    expect((firstCall[0] as { id: string }).id).toBe("track-1");
  });

  it("Enter on a folder card opens the folder (onOpenFolder)", () => {
    const onOpenFolder = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({ isFolder: true, trackInfo: undefined })}
        onOpenFolder={onOpenFolder}
      />,
    );
    const card = container.querySelector(".cursor-pointer") as Element;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onOpenFolder).toHaveBeenCalledWith("track-1", "My Song");
  });

  it("Space activates the card and preventDefaults (no page scroll)", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} onPlay={onPlay} />,
    );
    const card = container.querySelector(".cursor-pointer") as Element;
    expect(fireEvent.keyDown(card, { key: " " })).toBe(false);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("in selection mode Enter toggles selection (onToggleSelection)", () => {
    const onToggleSelection = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isSelectionMode
        onToggleSelection={onToggleSelection}
      />,
    );
    const card = container.querySelector(".cursor-pointer") as Element;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelection).toHaveBeenCalledWith("track-1");
  });

  it("does not activate when keydown bubbles from a focused child (e.g. menu button)", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} onPlay={onPlay} />,
    );
    const titleEl = container.querySelector("h3") as Element;
    fireEvent.keyDown(titleEl, { key: "Enter" });
    expect(onPlay).not.toHaveBeenCalled();
  });
});

describe("SongCard MoreMenu WAI-ARIA APG menu button pattern", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  const triggerButton = (): HTMLButtonElement | null =>
    document.querySelector("button");

  it('trigger has aria-haspopup="menu" and aria-expanded="false" while closed', () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    const trigger = triggerButton();
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });

  it('opens a dropdown with role="menu" and sets aria-expanded="true"', () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    fireEvent.click(triggerButton() as Element);
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    expect(triggerButton()?.getAttribute("aria-expanded")).toBe("true");
  });

  it('Escape closes the menu and resets aria-expanded to "false"', () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    fireEvent.click(triggerButton() as Element);
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(triggerButton()?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("SongCard navigate/locate highlight flash (single on→off cycle)", () => {
  const originalScrollIntoView = (
    Element.prototype.scrollIntoView as
      ((options?: ScrollIntoViewOptions) => void) | undefined
  )?.bind(Element.prototype);
  // jsdom WebIDL brand-checks `this` on getBoundingClientRect — binding it
  // (the lint-recommended fix) breaks every restore/instance call, so the
  // raw prototype reference is kept on purpose.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 0,
      size: 0,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    vi.useFakeTimers();
    // jsdom does not implement scrollIntoView (logs "Not implemented") — stub it.
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    });
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: originalGetBoundingClientRect,
    });
    cleanup();
  });

  const flashCard = (container: HTMLElement): HTMLDivElement | null =>
    container.querySelector<HTMLDivElement>(".p-3");

  const FLASH_ON_CLASS = "bg-white dark:bg-[#383a40]";
  const FLASH_OFF_CLASS = "bg-[#F8F9FA] dark:bg-[#202124]";

  it("flashes ON once on highlight, then OFF after one cycle, never re-toggling", async () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isHighlighted
        highlightTrigger={1}
      />,
    );

    const card = flashCard(container);
    expect(card).not.toBeNull();
    // (a) highlight color applied immediately after render
    expect(card?.className).toContain(FLASH_ON_CLASS);

    // (b) back to normal once the single flash duration elapses
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(card?.className).not.toContain(FLASH_ON_CLASS);
    expect(card?.className).toContain(FLASH_OFF_CLASS);

    // (c) stays off — no further toggle (the old 7×@300ms loop blinked again here)
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(card?.className).not.toContain(FLASH_ON_CLASS);
    expect(card?.className).toContain(FLASH_OFF_CLASS);
  });

  it("bumping highlightTrigger re-runs a single flash", async () => {
    const { container, rerender } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isHighlighted
        highlightTrigger={1}
      />,
    );
    const card = flashCard(container) as HTMLDivElement;
    expect(card.className).toContain(FLASH_ON_CLASS);
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(card.className).not.toContain(FLASH_ON_CLASS);

    rerender(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isHighlighted
        highlightTrigger={2}
      />,
    );
    expect(card.className).toContain(FLASH_ON_CLASS);
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(card.className).not.toContain(FLASH_ON_CLASS);
  });

  it("re-render with unchanged highlight props does not re-trigger the flash", async () => {
    const { container, rerender } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isHighlighted
        highlightTrigger={1}
      />,
    );
    const card = flashCard(container) as HTMLDivElement;
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(card.className).not.toContain(FLASH_ON_CLASS);

    rerender(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isHighlighted
        highlightTrigger={1}
      />,
    );
    expect(card.className).not.toContain(FLASH_ON_CLASS);
  });

  it("scrolls into view only when the card is off-screen", async () => {
    // Binding would strip the MockInstance API (.mock/.mockClear) — the
    // prototype reference is kept raw on purpose (the beforeEach stub owns it).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<
      typeof vi.fn
    >;
    // off-screen (jsdom default rect is 0,0 — above the header band) → scroll
    render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isHighlighted
        highlightTrigger={1}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    cleanup();

    // fully visible (inside header/player window band) → no scroll, still flashes
    scrollIntoView.mockClear();
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: () => ({
        x: 0,
        y: 200,
        top: 200,
        bottom: 320,
        left: 0,
        right: 800,
        width: 800,
        height: 120,
        toJSON: () => ({}),
      }),
    });
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isHighlighted
        highlightTrigger={1}
      />,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    const card = flashCard(container) as HTMLDivElement;
    expect(card.className).toContain(FLASH_ON_CLASS);
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(card.className).not.toContain(FLASH_ON_CLASS);
  });

  it("unmounting mid-flash cancels the pending timer without errors", async () => {
    const { unmount } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        isHighlighted
        highlightTrigger={1}
      />,
    );
    unmount();
    cleanup();
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(true).toBe(true);
  });
});

describe("SongCard now-playing visual distinction (hover-like gray, no lift)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 0,
      size: 0,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  const cardDiv = (container: HTMLElement): HTMLDivElement | null =>
    container.querySelector<HTMLDivElement>(".p-3");

  it("playing card uses the hover-like gray bg (same as idle hover), not the accent tint (light/dark)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isPlaying />,
    );
    const card = cardDiv(container);
    expect(card).not.toBeNull();
    expect(card?.className).toContain("bg-gray-100 dark:bg-[#2a2b2f]");
    expect(card?.className).not.toContain("bg-brand-primary/10");
    expect(card?.className).not.toContain("bg-[#F8F9FA]");
    expect(card?.className).toContain("shadow-sm");
  });

  it("playing card is NOT lifted in its static state (no standalone -translate-y-1; only the shared group-hover lift survives)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isPlaying />,
    );
    const card = cardDiv(container);
    expect(card?.className).not.toMatch(/(^|\s)-translate-y-1(\s|$)/);
  });

  it("playing card keeps the blue title and blue icon accents (hover-like)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isPlaying />,
    );
    expect(container.querySelector("h3")?.className).toContain(
      "text-brand-primary!",
    );
    const iconBox = container.querySelector(".lucide-music")?.parentElement;
    expect(iconBox?.className).toContain("bg-brand-primary/10!");
    expect(iconBox?.className).toContain("text-brand-primary!");
  });

  it("idle card keeps the original bg/hover unchanged", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const card = cardDiv(container);
    expect(card?.className).toContain("bg-[#F8F9FA] dark:bg-[#202124]");
    expect(card?.className).toContain(
      "hover:bg-gray-100 dark:hover:bg-[#2a2b2f]",
    );
    expect(card?.className).not.toContain("bg-brand-primary/10");
  });

  it("selected branch keeps priority and its own classes when selection mode is on", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isSelected isSelectionMode />,
    );
    const card = cardDiv(container);
    expect(card?.className).toContain(
      "bg-brand-primary/10 dark:bg-brand-primary/20 hover:bg-brand-primary/20 dark:hover:bg-brand-primary/30",
    );
    expect(card?.className).not.toContain("hover:bg-white");
  });
});

describe("SongCard size text uses shared formatBytes semantics (not the old MB-only formatSize)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // Metadata drives meta.size via getTrackMetadata; the card must render the
  // size span with the shared util's semantics ("500 KB", "5 MB", "0 B").
  const renderWithMetaSize = (size: number, duration = 123) => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration,
      size,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    return render(<SongCard {...baseProps} item={makeItem()} />);
  };

  it('size 0 → shows "0 B" (old formatSize returned "0 MB"; guard hid the span entirely)', async () => {
    renderWithMetaSize(0, 0);
    expect(await screen.findByText("0 B")).not.toBeNull();
    // Fix F: a 0/estimated duration renders "–", never the fake "00:00:00".
    expect(screen.getByText("–")).not.toBeNull();
    expect(screen.queryByText("00:00:00")).toBeNull();
  });

  it("real metadata duration renders formatted (no regression)", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 123,
      durationEstimated: false,
      size: 500 * 1024,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    render(<SongCard {...baseProps} item={makeItem()} />);
    expect(await screen.findByText("00:02:03")).not.toBeNull();
    expect(screen.queryByText("–")).toBeNull();
  });

  it('estimated duration (placeholder) renders "–" instead of a fake time', async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 0,
      durationEstimated: true,
      size: 0,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    render(<SongCard {...baseProps} item={makeItem()} />);
    expect(await screen.findByText("–")).not.toBeNull();
    expect(screen.queryByText("00:00:00")).toBeNull();
  });

  it('500 KB (512000 B) → shows "500 KB", not "0.5 MB"', async () => {
    renderWithMetaSize(500 * 1024);
    expect(await screen.findByText("500 KB")).not.toBeNull();
    expect(screen.queryByText("0.5 MB")).toBeNull();
  });

  it('5 MB → shows "5 MB", not "5.0 MB" (shared util trims trailing .0)', async () => {
    renderWithMetaSize(5 * 1024 * 1024);
    expect(await screen.findByText("5 MB")).not.toBeNull();
    expect(screen.queryByText("5.0 MB")).toBeNull();
  });

  it('1.5 MB (1536 KB) → shows "1.5 MB" (fraction digits preserved for non-whole units)', async () => {
    renderWithMetaSize(1536 * 1024);
    expect(await screen.findByText("1.5 MB")).not.toBeNull();
  });

  // Regression: makePlaceholder dropped `size`, so every failed metadata
  // fetch rendered "0 B" next to real sizes. A placeholder that carries the
  // size must render the real size, not "0 B".
  it('placeholder metadata with size renders the real size, not "0 B"', async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 0,
      durationEstimated: true,
      size: 4096,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    render(<SongCard {...baseProps} item={makeItem()} />);
    expect(await screen.findByText("4 KB")).not.toBeNull();
    expect(screen.queryByText("0 B")).toBeNull();
  });

  // Older cached placeholders (pre-fix) still lack the size field — the card
  // must fall back to the Drive listing size instead of showing "0 B".
  it("placeholder metadata without size falls back to the Drive listing size", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 0,
      durationEstimated: true,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    const item = makeItem();
    (item.trackInfo as { size?: number }).size = 4096;
    render(<SongCard {...baseProps} item={item} />);
    expect(await screen.findByText("4 KB")).not.toBeNull();
    expect(screen.queryByText("0 B")).toBeNull();
  });
});
