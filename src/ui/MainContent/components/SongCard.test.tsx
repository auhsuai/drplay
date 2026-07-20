// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

  it('fetches metadata even when coverUrl prop is provided (just skips cover)', async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} coverUrl="http://injected/cover" />);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith('track-1', 'tok', 1000, 'my song.mp3', expect.any(Object));
    await screen.findByText('Fetched Title');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://injected/cover');
  });

  it('self-fetches when no coverUrl prop is given', async () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith('track-1', 'tok', 1000, 'my song.mp3', expect.any(Object));
    // Cover eventually shows from fetched metadata.
    await screen.findByAltText('cover');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://cover/1');
  });

  it('fetches metadata when injectedCoverUrl is null', async () => {
    render(<SongCard {...baseProps} item={makeItem()} coverUrl={null} />);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    await screen.findByAltText('cover');
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
      <SongCard {...baseProps} item={makeItem()} coverUrl="http://injected/cover" />
    );
    await screen.findByText('Updated Title');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://injected/cover');
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
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://injected/cover');
  });
});
