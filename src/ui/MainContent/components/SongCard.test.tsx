// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SongCard } from './SongCard';
import type { DriveItem } from '../../../App';

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
  onPlay: vi.fn(),
  onOpenFolder: vi.fn(),
  token: 'tok',
  currentFolderId: 'root',
  currentFolderName: 'Root',
  folderHistory: [],
  onRefresh: () => {},
};

// This app streams directly from Google Drive with no tag/cover database, so
// SongCard no longer fetches anything — it just renders `item.title` (the
// Drive filename) and a generic Music/Folder icon.
describe('SongCard', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the track title directly from the item, no fetch', () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    expect(screen.getByText('My Song')).toBeTruthy();
  });

  it('renders a music icon (no cover image) for a track', () => {
    const { container } = render(<SongCard {...baseProps} item={makeItem()} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.lucide-music')).not.toBeNull();
  });

  it('renders a folder icon for folder items', () => {
    const { container } = render(
      <SongCard {...baseProps} item={makeItem({ isFolder: true, trackInfo: undefined })} />,
    );
    expect(container.querySelector('.lucide-folder')).not.toBeNull();
  });

  it('calls onOpenFolder when a folder item is clicked', () => {
    const onOpenFolder = vi.fn();
    const item = makeItem({ isFolder: true, trackInfo: undefined, title: 'My Folder' });
    const { container } = render(<SongCard {...baseProps} item={item} onOpenFolder={onOpenFolder} />);
    fireEvent.click(container.querySelector('.cursor-pointer')!);
    expect(onOpenFolder).toHaveBeenCalledWith('track-1', 'My Folder');
  });

  it('calls onPlay with the item trackInfo when a track is clicked', () => {
    const onPlay = vi.fn();
    const item = makeItem();
    const { container } = render(<SongCard {...baseProps} item={item} onPlay={onPlay} />);
    fireEvent.click(container.querySelector('.cursor-pointer')!);
    expect(onPlay).toHaveBeenCalledWith(item.trackInfo);
  });

  it('shows the file size when available', () => {
    render(<SongCard {...baseProps} item={makeItem()} />);
    expect(screen.getByText('0.0 MB')).toBeTruthy();
  });
});
