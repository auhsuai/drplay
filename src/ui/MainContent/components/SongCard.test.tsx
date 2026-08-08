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
import { DRAG_FOLDER_HOVER_EVENT } from "../../components/DropZone";
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

// Slice 2: cancelUpload is imported (runtime) by SongCard now. Spy on the real
// module's export (importOriginal spread keeps isUploading/subscribe real for
// MoreMenu) so the X-cancel click can be asserted without side effects.
const { cancelUploadMock, dismissUploadedMock } = vi.hoisted(() => ({
  cancelUploadMock: vi.fn(),
  dismissUploadedMock: vi.fn(),
}));

vi.mock("../../../utils/uploadManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/uploadManager")>()),
  cancelUpload: cancelUploadMock,
  dismissUploaded: dismissUploadedMock,
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

describe("SongCard drplay:// cover URL (S4 disk-cache path)", () => {
  // jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both are
  // undefined at runtime) — install observable spies so the S4 contract "the
  // blob path is gone, no blob URL is ever created" can be asserted.
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

  function deferred() {
    let resolve!: (value: never) => void;
    const promise = new Promise<never>((res) => {
      resolve = res;
    });
    return { promise, resolve };
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

  it("renders the thumb via drplay:// with lazy + async decoding inside the fixed 48px slot", async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(img.getAttribute("src")).toBe(
      "drplay://cover?id=track-1&thumb=true",
    );
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    // Fixed slot (w-12 h-12 = 48px): explicit width/height reserve the box,
    // preventing CLS while the drplay:// bytes load (web.dev CLS guidance).
    expect(img.getAttribute("width")).toBe("48");
    expect(img.getAttribute("height")).toBe("48");
    expect(container.querySelector(".lucide-music")).toBeNull();
  });

  it("falls back to a blob URL (built from the picture bytes) when the drplay:// image errors", async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("Fetched Title");
    expect(img.getAttribute("src")).toBe(
      "drplay://cover?id=track-1&thumb=true",
    );

    expect(() => fireEvent.error(img)).not.toThrow();

    const imgAfter = container.querySelector("img");
    expect(imgAfter?.getAttribute("src")).toBe("blob:mock-songcard-cover");
    expect(container.querySelector(".lucide-music")).toBeNull();
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe("image/png");
  });

  it("shows the Music icon when the blob fallback also errors (guarded, once only)", async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const img = await screen.findByAltText("Fetched Title");

    fireEvent.error(img);
    const img2 = await screen.findByAltText("Fetched Title");
    expect(img2.getAttribute("src")).toBe("blob:mock-songcard-cover");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);

    expect(() => fireEvent.error(img2)).not.toThrow();

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the Music icon directly when metadata has no picture bytes (no blob)", async () => {
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

  it("creates no blob URL while the drplay:// image loads fine (lazy fallback, RAM goal)", async () => {
    const d = deferred();
    mockedFetch.mockImplementationOnce(() => d.promise);

    const { unmount } = render(<SongCard {...baseProps} item={makeItem()} />);
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      d.resolve(metadataWithPicture());
      await Promise.resolve();
    });
    expect(createObjectURLSpy).not.toHaveBeenCalled();

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
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

describe("SongCard uploadState (dim + spinner)", () => {
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

  const cardEl = (container: HTMLElement): Element =>
    container.querySelector(".cursor-pointer") as Element;
  // lucide-react v1.x renders <LoaderCircle> with class 'lucide-loader-circle'
  // (LoaderCircle is the deprecated alias — PlayerBar still imports it).
  const spinnerEl = (container: HTMLElement): Element | null =>
    container.querySelector(".lucide-loader-circle");

  it("'uploading' → card dimmed (opacity-50 + pointer-events-none); centered spinner removed (determinate ring replaces it)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" />,
    );
    expect(cardEl(container).className).toContain("opacity-50");
    expect(cardEl(container).className).toContain("pointer-events-none");
    expect(spinnerEl(container)).toBeNull();
  });

  it("'parent-uploading' → small spinner, NO dim", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="parent-uploading"
      />,
    );
    expect(cardEl(container).className).not.toContain("opacity-50");
    expect(spinnerEl(container)).not.toBeNull();
  });

  it("'none' (default) → no spinner, no dim", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    expect(spinnerEl(container)).toBeNull();
    expect(cardEl(container).className).not.toContain("opacity-50");
  });

  it("'uploading' → click does NOT fire onPlay (race guard)", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        onPlay={onPlay}
      />,
    );
    fireEvent.click(cardEl(container));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("'uploading' → Enter does NOT fire onPlay (keyboard guard)", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        onPlay={onPlay}
      />,
    );
    fireEvent.keyDown(cardEl(container), { key: "Enter" });
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("'parent-uploading' → click still opens the folder (NOT blocked)", () => {
    const onOpenFolder = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({ isFolder: true, trackInfo: undefined })}
        uploadState="parent-uploading"
        onOpenFolder={onOpenFolder}
      />,
    );
    fireEvent.click(cardEl(container));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onOpenFolder).toHaveBeenCalledWith("track-1", "My Song");
  });

  it("'uploading' + selection mode → selection NOT toggled", () => {
    const onToggleSelection = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        isSelectionMode
        onToggleSelection={onToggleSelection}
      />,
    );
    fireEvent.click(cardEl(container));
    expect(onToggleSelection).not.toHaveBeenCalled();
  });
});

describe("SongCard upload progress ring + cancel X (slice 2)", () => {
  // The ring lives in a 24-unit viewBox with radius 10 (mirrors RING_RADIUS
  // in SongCard.tsx) — needed to assert the dash offset that renders the %.
  const RING_RADIUS = 10;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

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
    cancelUploadMock.mockClear();
    dismissUploadedMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  const ringSvg = (container: HTMLElement): Element | null =>
    container.querySelector("svg[aria-label]");
  const ringTextEl = (container: HTMLElement): Element | null =>
    container.querySelector("svg[aria-label] text");
  const progressCircle = (container: HTMLElement): Element | null =>
    container.querySelector("circle[stroke-dashoffset]");
  const cancelButton = (container: HTMLElement): Element | null =>
    container.querySelector('button[aria-label="upload.cancel_upload"]');
  const menuButton = (container: HTMLElement): Element | null =>
    container.querySelector('button[aria-haspopup="menu"]');

  it("'uploading' + uploadProgress=0.42 → ring beside title, dashoffset for the remaining 58%, NO % text", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.42}
      />,
    );
    const svg = ringSvg(container);
    expect(svg).not.toBeNull();
    // The percentage is conveyed through aria-label only — never rendered as
    // visible text inside the ring.
    expect(svg?.getAttribute("aria-label")).toBe("42%");
    expect(ringTextEl(container)).toBeNull();
    const circle = progressCircle(container);
    expect(circle).not.toBeNull();
    expect(Number(circle?.getAttribute("stroke-dashoffset"))).toBeCloseTo(
      RING_CIRCUMFERENCE * 0.58,
      4,
    );
    expect(circle?.getAttribute("stroke-dasharray")).toBe(
      String(RING_CIRCUMFERENCE),
    );
    // Ring starts at 12 o'clock (dash draws from the top, not 3 o'clock).
    expect(circle?.getAttribute("transform")).toContain("rotate(-90");
  });

  it("'uploading' → ring renders in the trailing menu slot (NOT beside the title); X cancel sits inside the ring", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.5}
      />,
    );
    const h3 = container.querySelector("h3");
    const svg = ringSvg(container);
    expect(h3).not.toBeNull();
    // The title row is a plain h3 now — the ring left the title area.
    expect(h3?.parentElement?.className).not.toContain(
      "flex items-center gap-2",
    );
    const x = cancelButton(container);
    expect(x).not.toBeNull();
    // Ring and X share the same wrapper — the trailing menu slot.
    expect(x?.parentElement).toBe(svg?.parentElement);
  });

  it("'uploading' + uploadProgress undefined → ring at 0% (no indeterminate state, no % text)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" />,
    );
    expect(ringSvg(container)).not.toBeNull();
    expect(ringTextEl(container)).toBeNull();
    const circle = progressCircle(container);
    expect(Number(circle?.getAttribute("stroke-dashoffset"))).toBeCloseTo(
      RING_CIRCUMFERENCE,
      4,
    );
  });

  it("rerender with a new uploadProgress updates the ring arc (memo comparator includes uploadProgress), no % text", () => {
    const { container, rerender } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.2}
      />,
    );
    expect(
      Number(progressCircle(container)?.getAttribute("stroke-dashoffset")),
    ).toBeCloseTo(RING_CIRCUMFERENCE * 0.8, 4);
    rerender(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.8}
      />,
    );
    expect(
      Number(progressCircle(container)?.getAttribute("stroke-dashoffset")),
    ).toBeCloseTo(RING_CIRCUMFERENCE * 0.2, 4);
    expect(ringTextEl(container)).toBeNull();
  });

  it("clamps out-of-range progress into 0..1 (progress can overshoot from truncation)", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={1.7}
      />,
    );
    expect(ringTextEl(container)).toBeNull();
    expect(
      Number(progressCircle(container)?.getAttribute("stroke-dashoffset")),
    ).toBeCloseTo(0, 4);
  });

  it("'uploading' → X replaces the MoreMenu trigger; click calls cancelUpload(item.id) and does NOT bubble to onPlay", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.5}
        onPlay={onPlay}
      />,
    );
    expect(menuButton(container)).toBeNull();
    const x = cancelButton(container);
    expect(x).not.toBeNull();
    fireEvent.click(x as Element);
    expect(cancelUploadMock).toHaveBeenCalledTimes(1);
    expect(cancelUploadMock).toHaveBeenCalledWith("track-1");
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("X cancel is hidden inside the ring by default and revealed on hover (w-3 h-3 fits the 20px ring)", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.3}
      />,
    );
    const x = cancelButton(container) as Element;
    expect(x.className).toContain("absolute inset-0");
    expect(x.className).toContain("opacity-0");
    // jsdom exposes svg.className as SVGAnimatedString — read the class
    // attribute instead (same for the ring svg assertions below).
    const icon = x.querySelector(".lucide-x");
    expect(icon?.getAttribute("class")).toContain("w-3");
    expect(icon?.getAttribute("class")).toContain("h-3");
  });

  it("'uploaded' → green check replaces the MoreMenu trigger; play dismisses the tint (MoreMenu returns)", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploaded"
        onPlay={onPlay}
      />,
    );
    // No menu, no X — a blue-green check in the menu slot instead.
    expect(menuButton(container)).toBeNull();
    expect(cancelButton(container)).toBeNull();
    // lucide v1 renders Check with class 'lucide-check' — the single-tick
    // check (user design), not the CircleCheck circle variant.
    const check = container.querySelector(".lucide-check");
    expect(check).not.toBeNull();
    expect(check?.getAttribute("class")).toContain("text-[#4285F4]");

    // Clicking the row to play clears the tint via dismissUploaded.
    fireEvent.click(container.querySelector(".p-3") as Element);
    expect(dismissUploadedMock).toHaveBeenCalledTimes(1);
    expect(dismissUploadedMock).toHaveBeenCalledWith("track-1");
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("'uploaded' + hideMenu → no check rendered (hideMenu wins)", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploaded"
        hideMenu
      />,
    );
    expect(container.querySelector(".lucide-check")).toBeNull();
  });

  it("'parent-uploading' → no X, MoreMenu still rendered, no ring", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="parent-uploading"
        uploadProgress={0.5}
      />,
    );
    expect(cancelButton(container)).toBeNull();
    expect(menuButton(container)).not.toBeNull();
    expect(ringSvg(container)).toBeNull();
  });

  it("'none' (default) → no ring, no X, MoreMenu renders as before", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    expect(ringSvg(container)).toBeNull();
    expect(cancelButton(container)).toBeNull();
    expect(menuButton(container)).not.toBeNull();
  });

  it("hideMenu + 'uploading' → no X (hideMenu wins)", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.4}
        hideMenu
      />,
    );
    expect(cancelButton(container)).toBeNull();
  });

  it("long title stays truncated (ellipsis); the ring lives in the menu slot, never squeezed by the title", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({
          title:
            "A very long song title that will definitely overflow the available space and must be truncated with an ellipsis",
        })}
        uploadState="uploading"
        uploadProgress={0.6}
      />,
    );
    const h3 = container.querySelector("h3");
    expect(h3?.className).toContain("truncate");
    // Title is a plain block again — no flex-1/ring pairing in the row.
    expect(h3?.className).not.toContain("flex-1");
    expect(ringSvg(container)).not.toBeNull();
  });

  it("X cancel button carries the i18n key upload.cancel_upload as aria-label", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.1}
      />,
    );
    expect(cancelButton(container)?.getAttribute("aria-label")).toBe(
      "upload.cancel_upload",
    );
  });

  it("'uploaded' check wrapper carries the i18n key upload.uploaded as aria-label (key must exist in both locales)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploaded" />,
    );
    expect(
      container.querySelector('[aria-label="upload.uploaded"]'),
    ).not.toBeNull();
  });

  it("'uploading' → the old centered LoaderCircle overlay is gone (ring replaces it)", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        uploadState="uploading"
        uploadProgress={0.5}
      />,
    );
    expect(container.querySelector(".lucide-loader-circle")).toBeNull();
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
    expect(card?.className).not.toContain("bg-[#4285F4]/10");
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
      "text-[#4285F4]!",
    );
    const iconBox = container.querySelector(".lucide-music")?.parentElement;
    expect(iconBox?.className).toContain("bg-[#4285F4]/10!");
    expect(iconBox?.className).toContain("text-[#4285F4]!");
  });

  it("idle card keeps the original bg/hover unchanged", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const card = cardDiv(container);
    expect(card?.className).toContain("bg-[#F8F9FA] dark:bg-[#202124]");
    expect(card?.className).toContain(
      "hover:bg-gray-100 dark:hover:bg-[#2a2b2f]",
    );
    expect(card?.className).not.toContain("bg-[#4285F4]/10");
  });

  it("selected branch keeps priority and its own classes when selection mode is on", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isSelected isSelectionMode />,
    );
    const card = cardDiv(container);
    expect(card?.className).toContain(
      "bg-[#4285F4]/10 dark:bg-[#4285F4]/20 hover:bg-[#4285F4]/20 dark:hover:bg-[#4285F4]/30",
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
});

describe("SongCard drag-over folder hover (folder drop target)", () => {
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

  const folderItem = (): DriveItem =>
    makeItem({ isFolder: true, trackInfo: undefined });
  const innerDiv = (container: HTMLElement): Element | null =>
    container.querySelector(".p-3");
  const announceHover = (folderId: string | null): void => {
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DRAG_FOLDER_HOVER_EVENT, { detail: { folderId } }),
      );
    });
  };
  // The idle card always carries the :hover-prefixed classes (hover:shadow-md,
  // group-hover:-translate-y-1, hover:bg-gray-100), so the drag-over state is
  // only detectable via the unprefixed always-on forms — assert with word
  // boundaries so 'hover:shadow-md' does not false-positive. The bg classes
  // carry the Tailwind important modifier (trailing !) so they beat the card
  // base bg (same specificity otherwise — order in the generated CSS wins).
  const hasDragLift = /(^|\s)shadow-md(\s|$)/;
  const hasDragTranslate = /(^|\s)-translate-y-1(\s|$)/;
  const hasDragGrayBg = /(^|\s)bg-gray-100!(\s|$)/;

  it("folder card marks its wrapper with data-folder-id (DropZone hit-test target)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={folderItem()} />,
    );
    const target = container.querySelector("[data-folder-id]");
    expect(target).not.toBeNull();
    expect(target?.getAttribute("data-folder-id")).toBe("track-1");
  });

  it("non-folder card does NOT carry data-folder-id (tracks are not drop targets)", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    expect(container.querySelector("[data-folder-id]")).toBeNull();
  });

  it("matching drag-hover event renders the same visual as a real mouse hover (shadow-md, -translate-y-1, gray bg with important prefix)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={folderItem()} />,
    );
    const inner = innerDiv(container);
    expect(inner?.className).not.toMatch(hasDragLift);
    announceHover("track-1");
    expect(inner?.className).toMatch(hasDragLift);
    expect(inner?.className).toMatch(hasDragTranslate);
    expect(inner?.className).toMatch(hasDragGrayBg);
    expect(inner?.className).toContain("dark:bg-[#2a2b2f]!");
  });

  it("selected folder card drag-hover keeps the accent tint with the important prefix (wins over base)", () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={folderItem()}
        isSelected
        isSelectionMode
      />,
    );
    announceHover("track-1");
    expect(innerDiv(container)?.className).toContain("bg-[#4285F4]/20!");
    expect(innerDiv(container)?.className).toContain("dark:bg-[#4285F4]/30!");
  });

  it("drag-hover event for a different folder does NOT highlight this card", () => {
    const { container } = render(
      <SongCard {...baseProps} item={folderItem()} />,
    );
    announceHover("folder-other");
    expect(innerDiv(container)?.className).not.toMatch(hasDragLift);
  });

  it("null folderId (drag left / dropped) clears the drag hover", () => {
    const { container } = render(
      <SongCard {...baseProps} item={folderItem()} />,
    );
    announceHover("track-1");
    expect(innerDiv(container)?.className).toMatch(hasDragLift);
    announceHover(null);
    expect(innerDiv(container)?.className).not.toMatch(hasDragLift);
  });

  it("non-folder cards ignore the drag-hover event entirely (no crash, no classes)", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    announceHover("track-1");
    expect(innerDiv(container)?.className).not.toMatch(hasDragLift);
  });
});
