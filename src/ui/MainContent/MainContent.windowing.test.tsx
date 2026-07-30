// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MainContent } from './MainContent';
import type { DriveItem } from '../../App';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({
      index: i,
      key: i,
      size: 92,
      start: i * 92,
    })),
    getTotalSize: () => count * 92,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
    containerRef: { current: document.createElement('div') },
  })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => null,
}));

vi.mock('../../db/db', () => ({
  db: { files: { toArray: vi.fn() } },
}));

vi.mock('../../utils/streamPrefetcher', () => ({
  prefetchVisibleTracks: vi.fn(),
  clearPrefetchedStreams: vi.fn(),
}));

vi.mock('../../utils/nextTrackPrefetcher', () => ({
  clearNextTrackPrefetches: vi.fn(),
}));

vi.mock('../../utils/normalizeText', () => ({
  normalizeText: (s: string) => s.toLowerCase(),
}));

vi.mock('../../hooks/useDriveExplorer', () => ({
  useDriveExplorer: () => ({
    currentItems: makeItems(3),
    filteredItems: makeItems(3),
    currentPage: 1,
    hasMoreItems: false,
    handleBulkMove: vi.fn(),
    handleBulkDelete: vi.fn(),
    handleDownloadMultiple: vi.fn(),
    totalSize: 0,
    searchQuery: '',
    setSearchQuery: vi.fn(),
  })
}));

vi.mock('./components/SongCard', () => ({
  SongCard: vi.fn(({ item }: { item: DriveItem }) => (
    <div data-testid="song-card" data-item-id={item.id} />
  )),
}));

function makeItems(n: number): DriveItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    title: `Song ${i}`,
    isFolder: false,
    trackInfo: {
      id: `id${i}`,
      title: `Song ${i}`,
      artist: '',
      streamUrl: '',
      size: 1000,
      originalName: `song${i}.mp3`,
    },
  }));
}

const baseProps = {
  activeTab: 'Drive',
  onPlay: vi.fn(),
  isLoading: false,
  onOpenFolder: vi.fn(),
  onBack: vi.fn(),
  hasHistory: false,
  folderHistory: [] as { id: string; name: string }[],
  currentFolderName: 'Root',
  onBreadcrumbClick: vi.fn(),
  token: 'tok',
  currentFolderId: 'root',
  onRefresh: vi.fn(),
  currentTrack: null,
};

describe('MainContent paginated rendering', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders all items when count is less than PAGE_SIZE', () => {
    render(<MainContent {...baseProps}  />);
    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBe(3);
  });

  it('should only render visible items using react-virtual', () => {
    render(
      <MainContent
        {...baseProps}
        
      />
    );
    expect(screen.getAllByTestId('song-card').length).toBe(60);
    expect(document.querySelector('main')).toBeTruthy();
  });
});
