// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SongCard } from './SongCard';
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

  it('does NOT self-fetch when coverUrl prop is provided', () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} coverUrl="http://injected/cover" />);
    expect(mockedFetch).not.toHaveBeenCalled();
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

  it('self-fetches when injectedCoverUrl is null (windowing evicted state, not a real url)', async () => {
    render(<SongCard {...baseProps} item={makeItem()} coverUrl={null} />);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith('track-1', 'tok', 1000, 'my song.mp3', expect.any(Object));
    await screen.findByAltText('cover');
  });

  it('does not self-fetch for folder items even without coverUrl', () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ isFolder: true, trackInfo: undefined })} />,
    );
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(container.querySelector('.lucide-folder')).not.toBeNull();
  });
});
