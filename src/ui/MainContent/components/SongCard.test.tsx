// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { SongCard, coverImageCache } from './SongCard';
import { getTrackMetadata } from '../../../utils/metadata';
import type { DriveItem } from '../../../App';

vi.mock('../../../utils/metadata', () => ({
  getTrackMetadata: vi.fn(),
}));

// Slice 2: cancelUpload is imported (runtime) by SongCard now. Spy on the real
// module's export (importOriginal spread keeps isUploading/subscribe real for
// MoreMenu) so the X-cancel click can be asserted without side effects.
const { cancelUploadMock } = vi.hoisted(() => ({ cancelUploadMock: vi.fn() }));

vi.mock('../../../utils/uploadManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/uploadManager')>()),
  cancelUpload: cancelUploadMock,
}));

const mockedFetch = vi.mocked(getTrackMetadata);

function makeItem(over: Partial<DriveItem> = {}): DriveItem {
  return {
    id: 'track-1',
    title: 'My Song',
    isFolder: false,
    trackInfo: {
      id: 'track-1',
      title: 'My Song',
      artist: '',
      streamUrl: '',
      size: 1000,
      originalName: 'my song.mp3',
    },
    ...over,
  };
}

const baseProps = {
  onPlay: () => {},
  onOpenFolder: () => {},
  token: 'tok',
  currentFolderId: 'root',
  currentFolderName: 'Root',
  folderHistory: [],
  onRefresh: () => {},
};

describe('SongCard coverUrl prop', () => {
  beforeEach(() => {
    coverImageCache.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: 'Fetched Artist',
      coverUrl: 'http://cover/1',
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('self-fetches on mount', async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    // SongCard debounces the metadata fetch by 150ms (visible-card guard in
    // SongCard.tsx), so the fetch assertion must wait for the timer.
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    expect(mockedFetch).toHaveBeenCalledWith('track-1', 'tok', 1000, 'my song.mp3', expect.any(Object));
    await screen.findByText('Fetched Title');
    await screen.findByAltText('Fetched Title');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://cover/1');
  });



  it('caches and reuses coverUrl from cache on remount', async () => {
    const { unmount, container } = render(<SongCard {...baseProps} item={makeItem()} />);
    await screen.findByAltText('Fetched Title');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://cover/1');

    unmount();
    cleanup();

    const { container: container2 } = render(<SongCard {...baseProps} item={makeItem()} />);
    await screen.findByAltText('Fetched Title');
    expect(container2.querySelector('img')?.getAttribute('src')).toBe('http://cover/1');
  });

  it('does not self-fetch for folder items even without coverUrl', () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ isFolder: true, trackInfo: undefined })} />,
    );
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(container.querySelector('.lucide-folder')).not.toBeNull();
  });

  it('non-folder without trackInfo: click is a no-op instead of crashing', () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ trackInfo: undefined })} onPlay={onPlay} />,
    );
    const card = container.querySelector('.cursor-pointer');
    expect(card).not.toBeNull();
    expect(() => fireEvent.click(card as Element)).not.toThrow();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('metadata update callback still works when injectedCoverUrl changes', async () => {
    mockedFetch.mockResolvedValue({
      title: 'Updated Title',
      artist: 'Updated Artist',
      coverUrl: 'http://cover/2',
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} />
    );
    await screen.findByText('Updated Title');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://cover/2');
    mockedFetch.mockClear();
    mockedFetch.mockResolvedValue({
      title: 'Re-fetched Title',
      artist: 'Re-fetched Artist',
      coverUrl: 'http://cover/3',
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId: 'track-1' } }));
    await screen.findByText('Re-fetched Title');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://cover/3');
  });

  it('re-renders on same-id item change (trackInfo.queueItemId) so click uses fresh track (stale-prop fix)', () => {
    const onPlay = vi.fn();
    const { rerender, container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({ trackInfo: { ...makeItem().trackInfo!, queueItemId: 'q-1' } })}
        onPlay={onPlay}
      />,
    );
    rerender(
      <SongCard
        {...baseProps}
        item={makeItem({ trackInfo: { ...makeItem().trackInfo!, queueItemId: 'q-2' } })}
        onPlay={onPlay}
      />,
    );
    const card = container.querySelector('.cursor-pointer');
    expect(card).not.toBeNull();
    fireEvent.click(card as Element);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay.mock.calls[0][0].queueItemId).toBe('q-2');
  });
});

describe('SongCard blob URL lifecycle (create in async .then, revoke must follow consumer)', () => {
  // jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both are
  // undefined at runtime) — install observable spies once so the card's blob
  // URL lifecycle can be asserted (same pattern as useNowPlayingMetadata.test.ts).
  beforeAll(() => {
    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
  });

  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;

  function metadataWithPicture(): never {
    return {
      title: 'Blob Track',
      artist: 'Blob Artist',
      duration: 0,
      size: 0,
      coverUrl: null,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureFormat: 'image/png',
    } as never;
  }

  function deferred() {
    let resolve!: (value: never) => void;
    const promise = new Promise<never>((res) => { resolve = res; });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    coverImageCache.clear();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: null,
      duration: 0,
      size: 0,
      coverUrl: null,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-songcard-cover');
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
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

  it('revokes every blob URL exactly once when metadata-updated triggers concurrent re-fetches', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();
    mockedFetch
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise)
      .mockImplementationOnce(() => d3.promise);

    const { unmount } = render(<SongCard {...baseProps} item={makeItem()} />);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    await act(async () => { d1.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId: 'track-1' } }));
      window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId: 'track-1' } }));
    });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(3));

    await act(async () => { d2.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(2);
    await act(async () => { d3.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(3);

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(3);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(3);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('never revokes a blob URL while it is still the displayed cover', async () => {
    const d1 = deferred();
    const d2 = deferred();
    mockedFetch
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const { unmount } = render(<SongCard {...baseProps} item={makeItem()} />);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    await act(async () => { d1.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId: 'track-1' } }));
    });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));

    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    await act(async () => { d2.resolve(metadataWithPicture()); });
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('creates no blob URL when metadata resolves after unmount and keeps create === revoke', async () => {
    const d = deferred();
    mockedFetch.mockImplementationOnce(() => d.promise);

    const { unmount } = render(<SongCard {...baseProps} item={makeItem()} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    unmount();
    cleanup();

    await act(async () => { d.resolve(metadataWithPicture()); });
    await flushMicrotasks();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('revokes exactly once per created URL when the item id changes quickly', async () => {
    const d1 = deferred();
    const d2 = deferred();
    mockedFetch
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const { rerender, unmount } = render(<SongCard {...baseProps} item={makeItem()} />);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    await act(async () => { d1.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);

    rerender(
      <SongCard
        {...baseProps}
        item={makeItem({
          id: 'track-2',
          title: 'Other Song',
          trackInfo: {
            id: 'track-2',
            title: 'Other Song',
            artist: '',
            streamUrl: '',
            size: 1000,
            originalName: 'other.mp3',
          },
        })}
      />,
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    await act(async () => { d2.resolve(metadataWithPicture()); });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(2);

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });
});

describe('SongCard keyboard accessibility (WCAG 2.1.1 Keyboard / WAI-ARIA APG button pattern)', () => {
  beforeEach(() => {
    coverImageCache.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: 'Fetched Artist',
      coverUrl: null,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('card is an accessible button: role="button" + tabIndex=0', () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const card = container.querySelector('.cursor-pointer');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('role')).toBe('button');
    expect(card?.getAttribute('tabindex')).toBe('0');
  });

  it('Enter on the card activates like a click (track → onPlay)', () => {
    const onPlay = vi.fn();
    const { container } = render(<SongCard {...baseProps} item={makeItem()} onPlay={onPlay} />);
    const card = container.querySelector('.cursor-pointer') as Element;
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay.mock.calls[0][0].id).toBe('track-1');
  });

  it('Enter on a folder card opens the folder (onOpenFolder)', () => {
    const onOpenFolder = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ isFolder: true, trackInfo: undefined })} onOpenFolder={onOpenFolder} />,
    );
    const card = container.querySelector('.cursor-pointer') as Element;
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onOpenFolder).toHaveBeenCalledWith('track-1', 'My Song');
  });

  it('Space activates the card and preventDefaults (no page scroll)', () => {
    const onPlay = vi.fn();
    const { container } = render(<SongCard {...baseProps} item={makeItem()} onPlay={onPlay} />);
    const card = container.querySelector('.cursor-pointer') as Element;
    expect(fireEvent.keyDown(card, { key: ' ' })).toBe(false);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('in selection mode Enter toggles selection (onToggleSelection)', () => {
    const onToggleSelection = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isSelectionMode onToggleSelection={onToggleSelection} />,
    );
    const card = container.querySelector('.cursor-pointer') as Element;
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(onToggleSelection).toHaveBeenCalledWith('track-1');
  });

  it('does not activate when keydown bubbles from a focused child (e.g. menu button)', () => {
    const onPlay = vi.fn();
    const { container } = render(<SongCard {...baseProps} item={makeItem()} onPlay={onPlay} />);
    const titleEl = container.querySelector('h3') as Element;
    fireEvent.keyDown(titleEl, { key: 'Enter' });
    expect(onPlay).not.toHaveBeenCalled();
  });
});

describe('SongCard MoreMenu WAI-ARIA APG menu button pattern', () => {
  beforeEach(() => {
    coverImageCache.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: 'Fetched Artist',
      coverUrl: null,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  const triggerButton = (): HTMLButtonElement | null =>
    document.querySelector('button');

  it('trigger has aria-haspopup="menu" and aria-expanded="false" while closed', () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    const trigger = triggerButton();
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a dropdown with role="menu" and sets aria-expanded="true"', () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    fireEvent.click(triggerButton() as Element);
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    expect(triggerButton()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('Escape closes the menu and resets aria-expanded to "false"', () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    fireEvent.click(triggerButton() as Element);
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(triggerButton()?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('SongCard navigate/locate highlight flash (single on→off cycle)', () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    coverImageCache.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: null,
      duration: 0,
      size: 0,
      coverUrl: null,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    vi.useFakeTimers();
    // jsdom does not implement scrollIntoView (logs "Not implemented") — stub it.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    });
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: originalGetBoundingClientRect,
    });
    cleanup();
  });

  const flashCard = (container: HTMLElement): HTMLDivElement | null =>
    container.querySelector<HTMLDivElement>('.p-3');

  const FLASH_ON_CLASS = 'bg-white dark:bg-[#383a40]';
  const FLASH_OFF_CLASS = 'bg-[#F8F9FA] dark:bg-[#202124]';

  it('flashes ON once on highlight, then OFF after one cycle, never re-toggling', async () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isHighlighted highlightTrigger={1} />,
    );

    const card = flashCard(container);
    expect(card).not.toBeNull();
    // (a) highlight color applied immediately after render
    expect(card?.className).toContain(FLASH_ON_CLASS);

    // (b) back to normal once the single flash duration elapses
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(card?.className).not.toContain(FLASH_ON_CLASS);
    expect(card?.className).toContain(FLASH_OFF_CLASS);

    // (c) stays off — no further toggle (the old 7×@300ms loop blinked again here)
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(card?.className).not.toContain(FLASH_ON_CLASS);
    expect(card?.className).toContain(FLASH_OFF_CLASS);
  });

  it('bumping highlightTrigger re-runs a single flash', async () => {
    const { container, rerender } = render(
      <SongCard {...baseProps} item={makeItem()} isHighlighted highlightTrigger={1} />,
    );
    const card = flashCard(container) as HTMLDivElement;
    expect(card.className).toContain(FLASH_ON_CLASS);
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(card.className).not.toContain(FLASH_ON_CLASS);

    rerender(<SongCard {...baseProps} item={makeItem()} isHighlighted highlightTrigger={2} />);
    expect(card.className).toContain(FLASH_ON_CLASS);
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(card.className).not.toContain(FLASH_ON_CLASS);
  });

  it('re-render with unchanged highlight props does not re-trigger the flash', async () => {
    const { container, rerender } = render(
      <SongCard {...baseProps} item={makeItem()} isHighlighted highlightTrigger={1} />,
    );
    const card = flashCard(container) as HTMLDivElement;
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(card.className).not.toContain(FLASH_ON_CLASS);

    rerender(<SongCard {...baseProps} item={makeItem()} isHighlighted highlightTrigger={1} />);
    expect(card.className).not.toContain(FLASH_ON_CLASS);
  });

  it('scrolls into view only when the card is off-screen', async () => {
    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;

    // off-screen (jsdom default rect is 0,0 — above the header band) → scroll
    render(<SongCard {...baseProps} item={makeItem()} isHighlighted highlightTrigger={1} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    await act(async () => { vi.advanceTimersByTime(400); });
    cleanup();

    // fully visible (inside header/player window band) → no scroll, still flashes
    scrollIntoView.mockClear();
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: () => ({ x: 0, y: 200, top: 200, bottom: 320, left: 0, right: 800, width: 800, height: 120, toJSON: () => ({}) }),
    });
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isHighlighted highlightTrigger={1} />,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    const card = flashCard(container) as HTMLDivElement;
    expect(card.className).toContain(FLASH_ON_CLASS);
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(card.className).not.toContain(FLASH_ON_CLASS);
  });

  it('unmounting mid-flash cancels the pending timer without errors', async () => {
    const { unmount } = render(
      <SongCard {...baseProps} item={makeItem()} isHighlighted highlightTrigger={1} />,
    );
    unmount();
    cleanup();
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(true).toBe(true);
  });
});

describe('SongCard uploadState (dim + spinner)', () => {
  beforeEach(() => {
    coverImageCache.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: null,
      duration: 0,
      size: 0,
      coverUrl: null,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  const cardEl = (container: HTMLElement): Element =>
    container.querySelector('.cursor-pointer') as Element;
  // lucide-react v1.x renders <Loader2> with class 'lucide-loader-circle'
  // (Loader2 is the deprecated alias — PlayerBar still imports it).
  const spinnerEl = (container: HTMLElement): Element | null =>
    container.querySelector('.lucide-loader-circle');

  it("'uploading' → card dimmed (opacity-50 + pointer-events-none); centered spinner removed (determinate ring replaces it)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" />,
    );
    expect(cardEl(container).className).toContain('opacity-50');
    expect(cardEl(container).className).toContain('pointer-events-none');
    expect(spinnerEl(container)).toBeNull();
  });

  it("'parent-uploading' → small spinner, NO dim", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="parent-uploading" />,
    );
    expect(cardEl(container).className).not.toContain('opacity-50');
    expect(spinnerEl(container)).not.toBeNull();
  });

  it("'none' (default) → no spinner, no dim", () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    expect(spinnerEl(container)).toBeNull();
    expect(cardEl(container).className).not.toContain('opacity-50');
  });

  it("'uploading' → click does NOT fire onPlay (race guard)", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" onPlay={onPlay} />,
    );
    fireEvent.click(cardEl(container));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("'uploading' → Enter does NOT fire onPlay (keyboard guard)", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" onPlay={onPlay} />,
    );
    fireEvent.keyDown(cardEl(container), { key: 'Enter' });
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
    expect(onOpenFolder).toHaveBeenCalledWith('track-1', 'My Song');
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

describe('SongCard upload progress ring + cancel X (slice 2)', () => {
  // The ring lives in a 24-unit viewBox with radius 10 (mirrors RING_RADIUS
  // in SongCard.tsx) — needed to assert the dash offset that renders the %.
  const RING_RADIUS = 10;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  beforeEach(() => {
    coverImageCache.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: null,
      duration: 0,
      size: 0,
      coverUrl: null,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    cancelUploadMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  const ringSvg = (container: HTMLElement): Element | null =>
    container.querySelector('svg[aria-label]');
  const ringText = (container: HTMLElement): string =>
    container.querySelector('svg[aria-label] text')?.textContent ?? '';
  const progressCircle = (container: HTMLElement): Element | null =>
    container.querySelector('circle[stroke-dashoffset]');
  const cancelButton = (container: HTMLElement): Element | null =>
    container.querySelector('button[aria-label="upload.cancel_upload"]');
  const menuButton = (container: HTMLElement): Element | null =>
    container.querySelector('button[aria-haspopup="menu"]');

  it("'uploading' + uploadProgress=0.42 → ring shows '42%' with dashoffset for the remaining 58%", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={0.42} />,
    );
    const svg = ringSvg(container);
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-label')).toBe('42%');
    expect(ringText(container)).toBe('42%');
    const circle = progressCircle(container);
    expect(circle).not.toBeNull();
    expect(Number(circle?.getAttribute('stroke-dashoffset'))).toBeCloseTo(RING_CIRCUMFERENCE * 0.58, 4);
    expect(circle?.getAttribute('stroke-dasharray')).toBe(String(RING_CIRCUMFERENCE));
    // Ring starts at 12 o'clock (dash draws from the top, not 3 o'clock).
    expect(circle?.getAttribute('transform')).toContain('rotate(-90');
  });

  it("'uploading' + uploadProgress undefined → ring at 0% (no indeterminate state)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" />,
    );
    expect(ringSvg(container)).not.toBeNull();
    expect(ringText(container)).toBe('0%');
    const circle = progressCircle(container);
    expect(Number(circle?.getAttribute('stroke-dashoffset'))).toBeCloseTo(RING_CIRCUMFERENCE, 4);
  });

  it('rerender with a new uploadProgress updates the ring % (memo comparator includes uploadProgress)', () => {
    const { container, rerender } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={0.2} />,
    );
    expect(ringText(container)).toBe('20%');
    rerender(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={0.8} />,
    );
    expect(ringText(container)).toBe('80%');
  });

  it('clamps out-of-range progress into 0..1 (progress can overshoot from truncation)', () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={1.7} />,
    );
    expect(ringText(container)).toBe('100%');
    expect(Number(progressCircle(container)?.getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 4);
  });

  it("'uploading' → X replaces the MoreMenu trigger; click calls cancelUpload(item.id) and does NOT bubble to onPlay", () => {
    const onPlay = vi.fn();
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={0.5} onPlay={onPlay} />,
    );
    expect(menuButton(container)).toBeNull();
    const x = cancelButton(container);
    expect(x).not.toBeNull();
    fireEvent.click(x as Element);
    expect(cancelUploadMock).toHaveBeenCalledTimes(1);
    expect(cancelUploadMock).toHaveBeenCalledWith('track-1');
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('X button keeps WCAG 2.5.8 minimum target size (p-1.5 + w-4 h-4 icon = 28px hit area)', () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={0.3} />,
    );
    const x = cancelButton(container) as Element;
    expect(x.className).toContain('p-1.5');
    // jsdom exposes svg.className as SVGAnimatedString — read the class
    // attribute instead (same for the ring svg assertions below).
    const icon = x.querySelector('.lucide-x');
    expect(icon?.getAttribute('class')).toContain('w-4');
    expect(icon?.getAttribute('class')).toContain('h-4');
  });

  it("'parent-uploading' → no X, MoreMenu still rendered, no ring", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="parent-uploading" uploadProgress={0.5} />,
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
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={0.4} hideMenu />,
    );
    expect(cancelButton(container)).toBeNull();
  });

  it('long title stays truncated (ellipsis) and the ring never gets squeezed (h3 flex-1 + ring shrink-0)', () => {
    const { container } = render(
      <SongCard
        {...baseProps}
        item={makeItem({
          title: 'A very long song title that will definitely overflow the available space and must be truncated with an ellipsis',
        })}
        uploadState="uploading"
        uploadProgress={0.6}
      />,
    );
    const h3 = container.querySelector('h3');
    expect(h3?.className).toContain('truncate');
    expect(h3?.className).toContain('flex-1');
    const titleRow = h3?.parentElement;
    expect(titleRow?.className).toContain('flex items-center gap-2 min-w-0');
    expect(ringSvg(container)?.getAttribute('class')).toContain('shrink-0');
  });

  it('X cancel button carries the i18n key upload.cancel_upload as aria-label', () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={0.1} />,
    );
    expect(cancelButton(container)?.getAttribute('aria-label')).toBe('upload.cancel_upload');
  });

  it("'uploading' → the old centered Loader2 overlay is gone (ring replaces it)", () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} uploadState="uploading" uploadProgress={0.5} />,
    );
    expect(container.querySelector('.lucide-loader-circle')).toBeNull();
  });
});

describe('SongCard now-playing visual distinction (hover-like gray, no lift)', () => {
  beforeEach(() => {
    coverImageCache.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: 'Fetched Title',
      artist: null,
      duration: 0,
      size: 0,
      coverUrl: null,
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  const cardDiv = (container: HTMLElement): HTMLDivElement | null =>
    container.querySelector<HTMLDivElement>('.p-3');

  it('playing card uses the hover-like gray bg (same as idle hover), not the accent tint (light/dark)', () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} isPlaying />);
    const card = cardDiv(container);
    expect(card).not.toBeNull();
    expect(card?.className).toContain('bg-gray-100 dark:bg-[#2a2b2f]');
    expect(card?.className).not.toContain('bg-[#4285F4]/10');
    expect(card?.className).not.toContain('bg-[#F8F9FA]');
    expect(card?.className).toContain('shadow-sm');
  });

  it('playing card is NOT lifted in its static state (no standalone -translate-y-1; only the shared group-hover lift survives)', () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} isPlaying />);
    const card = cardDiv(container);
    expect(card?.className).not.toMatch(/(^|\s)-translate-y-1(\s|$)/);
  });

  it('playing card keeps the blue title and blue icon accents (hover-like)', () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} isPlaying />);
    expect(container.querySelector('h3')?.className).toContain('!text-[#4285F4]');
    const iconBox = container.querySelector('.lucide-music')?.parentElement;
    expect(iconBox?.className).toContain('!bg-[#4285F4]/10');
    expect(iconBox?.className).toContain('!text-[#4285F4]');
  });

  it('idle card keeps the original bg/hover unchanged', () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    const card = cardDiv(container);
    expect(card?.className).toContain('bg-[#F8F9FA] dark:bg-[#202124]');
    expect(card?.className).toContain('hover:bg-gray-100 dark:hover:bg-[#2a2b2f]');
    expect(card?.className).not.toContain('bg-[#4285F4]/10');
  });

  it('selected branch keeps priority and its own classes when selection mode is on', () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem()} isSelected isSelectionMode />,
    );
    const card = cardDiv(container);
    expect(card?.className).toContain('bg-[#4285F4]/10 dark:bg-[#4285F4]/20 hover:bg-[#4285F4]/20 dark:hover:bg-[#4285F4]/30');
    expect(card?.className).not.toContain('hover:bg-white');
  });
});
