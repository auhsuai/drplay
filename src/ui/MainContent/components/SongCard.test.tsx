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

// dbMetadata is only ever passed by MainContent.tsx for the "My Drive" list —
// these tests cover that opt-in path without affecting the plain-filename
// behavior exercised above (used by Home/LikedSongs/Playlists, which never
// pass this prop).
describe('SongCard dbMetadata (My Drive tag lookup)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the DB tag title instead of the filename when dbMetadata is provided', () => {
    render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        dbMetadata={{ title: 'Real Tag Title', artist: 'Real Artist', duration: 0 }}
      />,
    );
    expect(screen.getByText('Real Tag Title')).toBeTruthy();
    expect(screen.queryByText('My Song')).toBeNull();
  });

  it('falls back to the filename title when dbMetadata has no title', () => {
    render(<SongCard {...baseProps} item={makeItem()} dbMetadata={undefined} />);
    expect(screen.getByText('My Song')).toBeTruthy();
  });

  it('shows a formatted duration alongside size when dbMetadata provides one', () => {
    render(
      <SongCard
        {...baseProps}
        item={makeItem()}
        dbMetadata={{ title: 'Real Tag Title', artist: '', duration: 125 }}
      />,
    );
    expect(screen.getByText('02:05')).toBeTruthy();
    expect(screen.getByText('0.0 MB')).toBeTruthy();
  });

  it('enriches onPlay with the DB tag title/artist when a track is clicked', () => {
    const onPlay = vi.fn();
    const item = makeItem();
    const { container } = render(
      <SongCard
        {...baseProps}
        item={item}
        onPlay={onPlay}
        dbMetadata={{ title: 'Real Tag Title', artist: 'Real Artist', duration: 0 }}
      />,
    );
    fireEvent.click(container.querySelector('.cursor-pointer')!);
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Real Tag Title', artist: 'Real Artist' }),
    );
  });
});
