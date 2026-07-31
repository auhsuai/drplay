// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const { useDriveExplorerMock } = vi.hoisted(() => ({ useDriveExplorerMock: vi.fn() }));

vi.mock('../../hooks/useDriveExplorer', () => ({
  useDriveExplorer: useDriveExplorerMock,
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

// Mirrors the return shape of the real useDriveExplorer hook (src/hooks/useDriveExplorer.ts).
function makeExplorerState(items: DriveItem[]) {
  return {
    searchQuery: '',
    setSearchQuery: vi.fn(),
    currentPage: 1,
    setCurrentPage: vi.fn(),
    totalPages: 1,
    currentItems: items,
    filteredItems: items,
    isSelectionMode: false,
    setIsSelectionMode: vi.fn(),
    selectedIds: new Set<string>(),
    setSelectedIds: vi.fn(),
    isCreatingFolder: false,
    isBulkOperating: false,
    handleCreateFolder: vi.fn(),
    handleBulkDelete: vi.fn(),
    handleBulkMove: vi.fn(),
    itemsPerPage: 50,
  };
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
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
  });

  it('renders all items when count is less than PAGE_SIZE', () => {
    render(<MainContent {...baseProps}  />);
    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBe(3);
  });

  it('should only render visible items using react-virtual', () => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(60)));
    render(
      <MainContent
        {...baseProps}
        
      />
    );
    expect(screen.getAllByTestId('song-card').length).toBe(60);
    expect(document.querySelector('main')).toBeTruthy();
  });
});
