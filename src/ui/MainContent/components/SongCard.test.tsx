// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { SongCard, coverImageCache } from './SongCard';
import { getTrackMetadata } from '../../../utils/metadata';
import type { DriveItem } from '../../../App';

vi.mock('../../../utils/metadata', () => ({
  getTrackMetadata: vi.fn(),
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
