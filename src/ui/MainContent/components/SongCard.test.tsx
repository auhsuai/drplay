// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
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
    await screen.findByAltText('cover');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://cover/1');
  });



  it('caches and reuses coverUrl from cache on remount', async () => {
    const { unmount, container } = render(<SongCard {...baseProps} item={makeItem()} />);
    await screen.findByAltText('cover');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://cover/1');

    unmount();
    cleanup();

    const { container: container2 } = render(<SongCard {...baseProps} item={makeItem()} />);
    await screen.findByAltText('cover');
    expect(container2.querySelector('img')?.getAttribute('src')).toBe('http://cover/1');
  });

  it('does not self-fetch for folder items even without coverUrl', () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ isFolder: true, trackInfo: undefined })} />,
    );
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(container.querySelector('.lucide-folder')).not.toBeNull();
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
