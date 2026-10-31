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
import { LIST_DATE_TRACK, LIST_SIZE_TRACK } from "./listColumnLayout";
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
    // The displayed name is the full Drive filename (with extension) — the
    // ID3 title must never replace it.
    await screen.findByText("my song.mp3");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
  });

  it("extension is visible: renders the full originalName, not the stripped title", () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    expect(screen.getByText("my song.mp3")).not.toBeNull();
    expect(screen.queryByText("My Song")).toBeNull();
  });

  it("metadata load updates artist/duration but keeps the filename as the title", async () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    // The filename title renders synchronously; waiting on the debounced
    // metadata fetch proves the no-ID3-takeover assertion runs AFTER load.
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    // No ID3-title takeover, before or after the async load.
    expect(screen.queryByText("Fetched Title")).toBeNull();
    expect(screen.getByText("my song.mp3")).not.toBeNull();
  });

  it("re-fetches metadata on remount (no cross-mount cover cache)", async () => {
    const { unmount } = render(<SongCard {...baseProps} item={makeItem()} />);
    // The filename renders synchronously, so the async signal here is the
    // debounced fetch itself (the old await on the ID3 title was the proxy).
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    unmount();
    cleanup();
    mockedFetch.mockClear();

    const { container: container2 } = render(
      <SongCard {...baseProps} item={makeItem()} />,
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
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
    const img = await screen.findByAltText("my song.mp3");

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
    const img = await screen.findByAltText("my song.mp3");
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
    // Metadata resolution is async; the filename is the title either way.
    await screen.findByText("my song.mp3");

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
    const img = await screen.findByAltText("my song.mp3");

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
    const img = await screen.findByAltText("my song.mp3");

    expect(img.getAttribute("src")).toMatch(/^blob:/);
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.size).toBe(4);
    expect(blobArg.type).toBe("image/png");
    expect(container.querySelector(".lucide-music")).toBeNull();
  });

  it("creates exactly one blob URL from the picture bytes and revokes it on unmount", async () => {
    const { unmount } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("my song.mp3");
    expect(img.getAttribute("src")).toBe("blob:mock-songcard-cover");
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe("image/png");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    unmount();
    await flushMicrotasks();

    // New contract (B05-2): the hook owns the blob URL it created and revokes
    // it once the <img> no longer references it. Tauri/WebView2 keeps the page
    // alive for the whole session, so an unrevoked URL pins its bytes until
    // the app closes.
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-songcard-cover");
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

describe("SongCard context menu closes after Download Song (forceOpen path)", () => {
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

  it("closes the right-click menu after Download Song while the dialog stays open", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const card = container.querySelector(".cursor-pointer") as Element;
    expect(card).not.toBeNull();

    fireEvent.contextMenu(card);
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "menu.download" }));

    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(screen.getByText("menu.file_name")).toBeTruthy();
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
      "text-brand-text!",
    );
    const iconBox = container.querySelector(".lucide-music")?.parentElement;
    expect(iconBox?.className).toContain("bg-brand-primary/10!");
    expect(iconBox?.className).toContain("text-brand-text!");
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

describe("SongCard size display uses shared formatBytes semantics (subtitle → dedicated column)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // The size display moved from the subtitle (meta.size, gated on the async
  // metadata load) to the dedicated Size column (item.size, always visible).
  // The shared formatBytes semantics must survive the move.
  const renderWithSize = (size: number, duration = 123) => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration,
      size,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    return render(<SongCard {...baseProps} item={makeItem({ size })} />);
  };

  it('size 0 → shows "0 B" in the column (old formatSize returned "0 MB")', async () => {
    renderWithSize(0, 0);
    expect(await screen.findByText("0 B")).not.toBeNull();
    // Fix F: a 0/estimated duration renders "–", never the fake "00:00:00".
    // Awaited: the column renders synchronously now, but the duration span
    // still waits for the debounced metadata fetch.
    expect(await screen.findByText("–")).not.toBeNull();
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
    render(<SongCard {...baseProps} item={makeItem({ size: 500 * 1024 })} />);
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
    render(<SongCard {...baseProps} item={makeItem({ size: 0 })} />);
    expect(await screen.findByText("–")).not.toBeNull();
    expect(screen.queryByText("00:00:00")).toBeNull();
  });

  it('500 KB (512000 B) → shows "500 KB", not "0.5 MB"', async () => {
    renderWithSize(500 * 1024);
    expect(await screen.findByText("500 KB")).not.toBeNull();
    expect(screen.queryByText("0.5 MB")).toBeNull();
  });

  it('5 MB → shows "5 MB", not "5.0 MB" (shared util trims trailing .0)', async () => {
    renderWithSize(5 * 1024 * 1024);
    expect(await screen.findByText("5 MB")).not.toBeNull();
    expect(screen.queryByText("5.0 MB")).toBeNull();
  });

  it('1.5 MB (1536 KB) → shows "1.5 MB" (fraction digits preserved for non-whole units)', async () => {
    renderWithSize(1536 * 1024);
    expect(await screen.findByText("1.5 MB")).not.toBeNull();
  });

  it("a metadata size that disagrees with the listing size is ignored (column reads item.size)", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 0,
      durationEstimated: true,
      size: 4096,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    render(<SongCard {...baseProps} item={makeItem({ size: 8192 })} />);
    expect(await screen.findByText("8 KB")).not.toBeNull();
    expect(screen.queryByText("4 KB")).toBeNull();
  });
});

// Trash-parity icon set for the Drive list: video files render the inline
// film SVG (same artwork TrashItemRow ships), music files keep Music, folders
// keep Folder, and cover art still wins over every icon.
describe("SongCard video icon (film, Trash parity)", () => {
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

  it.each(["movie.mkv", "clip.mp4"])(
    "renders the film SVG with rect artwork for %s",
    (name) => {
      const { container } = render(
        <SongCard
          {...baseProps}
          item={makeItem({
            trackInfo: {
              ...makeItem().trackInfo,
              originalName: name,
            } as NonNullable<DriveItem["trackInfo"]>,
          })}
        />,
      );
      const film = container.querySelector("svg.lucide-film");
      expect(film).not.toBeNull();
      expect(film?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(film?.querySelector("rect")).not.toBeNull();
    },
  );

  it("keeps Music for song.mp3 (no film icon)", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    expect(container.querySelector("svg.lucide-film")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
  });

  it("keeps Music for an extension-less non-folder", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({
          trackInfo: {
            ...makeItem().trackInfo,
            originalName: "extensionless",
          } as NonNullable<DriveItem["trackInfo"]>,
        })}
      />,
    );
    expect(container.querySelector("svg.lucide-film")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
  });

  it("folders keep the Folder icon (no film)", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({ isFolder: true, trackInfo: undefined })}
      />,
    );
    expect(container.querySelector("svg.lucide-film")).toBeNull();
    expect(container.querySelector(".lucide-folder")).not.toBeNull();
  });

  it("cover art still wins over the film icon", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureFormat: "image/png",
    } as never);
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({
          trackInfo: {
            ...makeItem().trackInfo,
            originalName: "movie.mkv",
          } as NonNullable<DriveItem["trackInfo"]>,
        })}
      />,
    );
    await screen.findByAltText("movie.mkv");
    expect(container.querySelector("svg.lucide-film")).toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
    // The full filename (with .mkv) is the displayed title, and the ID3
    // title still does not replace it.
    expect(screen.getByText("movie.mkv")).not.toBeNull();
    expect(screen.queryByText("Fetched Title")).toBeNull();
  });
});

// Date column: every row (folders included) renders its real modifiedTime in
// a dedicated column; missing/malformed timestamps render "—", never a
// fabricated date (same policy as TrashItemRow.formatDeletedDate).
describe("SongCard date column", () => {
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

  it("renders the real modifiedTime via the same zero-padded locale expression", () => {
    const raw = "2026-03-01T12:34:56.000Z";
    const expected = new Date(raw).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ modifiedTime: raw })} />,
    );
    expect(screen.getByText(expected)).not.toBeNull();
    // The date lives in the shared Date track (LIST_DATE_TRACK), so header and
    // row stay in lockstep — assert the token's own class string, not a raw
    // arbitrary-value selector.
    const dateCells = Array.from(container.querySelectorAll("span")).filter(
      (el) => el.className.includes(LIST_DATE_TRACK.split(" ")[1] ?? ""),
    );
    expect(dateCells).toHaveLength(1);
    expect(dateCells[0]?.textContent).toBe(expected);
  });

  it("zero-pads single-digit day and month (01/03, not 1/3)", () => {
    const raw = "2026-03-01T12:00:00.000Z";
    render(<SongCard {...baseProps} item={makeItem({ modifiedTime: raw })} />);

    const date = new Date(raw);
    const padded = date.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const unpadded = date.toLocaleDateString();
    expect(padded).not.toBe(unpadded);
    expect(screen.getByText(padded)).not.toBeNull();
    expect(screen.queryByText(unpadded)).toBeNull();
  });

  it("folders show their real modifiedTime too", () => {
    const raw = "2026-02-15T08:00:00.000Z";
    const expected = new Date(raw).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    render(
      <SongCard
        {...baseProps}
        item={makeItem({
          isFolder: true,
          trackInfo: undefined,
          modifiedTime: raw,
        })}
      />,
    );
    expect(screen.getByText(expected)).not.toBeNull();
  });

  it('missing modifiedTime renders "—" (never fabricates a date)', () => {
    render(<SongCard {...baseProps} item={makeItem({})} />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it('malformed modifiedTime renders "—"', () => {
    render(
      <SongCard
        {...baseProps}
        item={makeItem({ modifiedTime: "not-a-date" })}
      />,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("memo: rerender with same id + changed modifiedTime updates the rendered date", () => {
    const old = "2026-01-01T00:00:00.000Z";
    const changed = "2026-06-15T00:00:00.000Z";
    const dateOpts = {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    } as const;
    const { rerender } = render(
      <SongCard {...baseProps} item={makeItem({ modifiedTime: old })} />,
    );
    expect(
      screen.getByText(new Date(old).toLocaleDateString(undefined, dateOpts)),
    ).toBeTruthy();
    rerender(
      <SongCard {...baseProps} item={makeItem({ modifiedTime: changed })} />,
    );
    expect(
      screen.getByText(
        new Date(changed).toLocaleDateString(undefined, dateOpts),
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(new Date(old).toLocaleDateString(undefined, dateOpts)),
    ).toBeNull();
  });
});

// Size column: driven by the listing's item.size (number), independent of the
// async metadata load — the subtitle no longer shows a size at all (the user
// moved size out of the subtitle into its own column).
describe("SongCard size column", () => {
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

  it("renders formatBytes(item.size) for a numeric size", () => {
    render(
      <SongCard {...baseProps} item={makeItem({ size: 5 * 1024 * 1024 })} />,
    );
    expect(screen.getByText("5 MB")).not.toBeNull();
  });

  it("renders formatBytes for 0-byte files (0 B, not an em dash)", () => {
    render(<SongCard {...baseProps} item={makeItem({ size: 0 })} />);
    expect(screen.getByText("0 B")).not.toBeNull();
  });

  it('folders and missing size render "—" in the shared Size track', () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({
          isFolder: true,
          trackInfo: undefined,
          size: undefined,
        })}
      />,
    );
    // Size cell identified via the shared LIST_SIZE_TRACK width token so a
    // future track change does not silently break this assertion.
    const sizeWidth = LIST_SIZE_TRACK.split(" ")[0] ?? "";
    const sizeCells = Array.from(container.querySelectorAll("span")).filter(
      (el) =>
        el.className.includes(sizeWidth) && el.className.includes("text-right"),
    );
    expect(sizeCells).toHaveLength(1);
    expect(sizeCells[0]?.textContent).toBe("—");
  });

  it("a file with missing size renders — as well (no fabricated 0 B)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ size: undefined })} />,
    );
    const sizeWidth = LIST_SIZE_TRACK.split(" ")[0] ?? "";
    const sizeCells = Array.from(container.querySelectorAll("span")).filter(
      (el) =>
        el.className.includes(sizeWidth) && el.className.includes("text-right"),
    );
    expect(sizeCells).toHaveLength(1);
    expect(sizeCells[0]?.textContent).toBe("—");
  });

  it("subtitle no longer contains a size (duration only when metadata loads)", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: null,
      duration: 123,
      durationEstimated: false,
      size: 4096,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    render(<SongCard {...baseProps} item={makeItem({ size: 4096 })} />);
    expect(await screen.findByText("00:02:03")).not.toBeNull();
    // The duration-only subtitle must not grow a size segment next to it.
    // ("4 KB" appears exactly once — in the dedicated Size column.)
    expect(screen.getAllByText("4 KB")).toHaveLength(1);
  });
});

// Virtual root ("Root Folders") rows are folder navigation targets with no
// date/size — the header is already hidden there, so the two "—" placeholders
// would float with no header above them. hideColumns drops both cells and
// nothing else.
describe("SongCard hideColumns (virtual root rows)", () => {
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

  it("omits the date and size cells (no — placeholders) while keeping title and subtitle", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({
          title: "My Root",
          isFolder: true,
          trackInfo: undefined,
        })}
        hideColumns
      />,
    );

    // Both column tracks are gone.
    const dateWidth = LIST_DATE_TRACK.split(" ")[1] ?? "";
    const sizeWidth = LIST_SIZE_TRACK.split(" ")[0] ?? "";
    const cells = Array.from(container.querySelectorAll("span"));
    expect(cells.filter((el) => el.className.includes(dateWidth))).toHaveLength(
      0,
    );
    expect(
      cells.filter(
        (el) =>
          el.className.includes(sizeWidth) &&
          el.className.includes("text-right"),
      ),
    ).toHaveLength(0);
    // No dash placeholders anywhere in the row.
    expect(screen.queryAllByText("—")).toHaveLength(0);

    // The row still renders its identity + folder subtitle.
    expect(screen.getByText("My Root")).not.toBeNull();
    expect(screen.getByText("drive.folders")).not.toBeNull();
  });

  it("still renders both columns by default (hideColumns omitted)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ modifiedTime: undefined })} />,
    );
    const dateWidth = LIST_DATE_TRACK.split(" ")[1] ?? "";
    expect(
      Array.from(container.querySelectorAll("span")).filter((el) =>
        el.className.includes(dateWidth),
      ),
    ).toHaveLength(1);
    // Missing date/size → the two placeholders are present again.
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
