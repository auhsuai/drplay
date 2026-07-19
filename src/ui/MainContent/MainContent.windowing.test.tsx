// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MainContent } from './MainContent';
import type { DriveItem } from '../../App';

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

const hoisted = vi.hoisted(() => {
  const getVirtualItems = vi.fn<() => { key: number; index: number; start: number; size: number }[]>();
  const getTotalSize = vi.fn<() => number>();
  const mockUseCoverWindowing = vi.fn<() => Map<string, string | null>>();
  return {
    getVirtualItems,
    getTotalSize,
    mockUseCoverWindowing,
    useVirtualizer: vi.fn(() => ({
      getVirtualItems,
      getTotalSize,
    })),
  };
});

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: hoisted.useVirtualizer,
}));

vi.mock('../../hooks/useScrollVelocity', () => ({
  useScrollVelocity: vi.fn(() => ({ velocity: 0, dynamicMargin: 3 })),
}));

vi.mock('../../hooks/useCoverWindowing', () => ({
  useCoverWindowing: hoisted.mockUseCoverWindowing,
  PREFETCH_MARGIN_SLOW: 3,
  PREFETCH_MARGIN_MED: 6,
  PREFETCH_MARGIN_FAST: 12,
  VELOCITY_FAST_THRESHOLD: 100,
  VELOCITY_MED_THRESHOLD: 40,
  EVICT_MULTIPLIER: 2,
}));

vi.mock('./components/SongCard', () => ({
  SongCard: vi.fn(({ coverUrl, item }: { coverUrl?: string | null; item: DriveItem }) => (
    <div data-testid="song-card" data-cover-url={String(coverUrl)} data-item-id={item.id}>
      {coverUrl ? <img alt="cover" src={coverUrl} /> : <div data-testid="music-icon" />}
    </div>
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
  items: makeItems(3),
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

describe('MainContent windowing integration', () => {
  beforeEach(() => {
    hoisted.getVirtualItems.mockReset();
    hoisted.getTotalSize.mockReset();
    hoisted.mockUseCoverWindowing.mockReset();
    hoisted.mockUseCoverWindowing.mockReturnValue(new Map<string, string | null>());
    hoisted.getVirtualItems.mockReturnValue([
      { key: 0, index: 0, start: 0, size: 92 },
      { key: 1, index: 1, start: 92, size: 92 },
    ]);
    hoisted.getTotalSize.mockReturnValue(4600);
  });

  afterEach(() => {
    cleanup();
  });

  it('only renders virtualized (visible) rows, not all items', () => {
    render(<MainContent {...baseProps} items={makeItems(50)} />);
    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBe(2);
    expect(cards.length).toBeLessThan(50);
  });

  it('calls useCoverWindowing with full items and visible range', () => {
    const items = makeItems(50);
    render(<MainContent {...baseProps} items={items} />);
    expect(hoisted.mockUseCoverWindowing).toHaveBeenCalledWith(
      expect.objectContaining({
        items,
        range: expect.any(Object),
        token: 'tok',
      }),
    );
  });

  it('passes coverUrl from hook to SongCard', () => {
    const mockCovers = new Map<string, string | null>();
    mockCovers.set('id0', 'http://cover/0');
    mockCovers.set('id1', null);
    hoisted.mockUseCoverWindowing.mockReturnValue(mockCovers);

    render(<MainContent {...baseProps} items={makeItems(3)} />);
    const cards = screen.getAllByTestId('song-card');
    expect(cards[0].getAttribute('data-cover-url')).toBe('http://cover/0');
    expect(cards[1].getAttribute('data-cover-url')).toBe('null');
  });

  it('renders Music icon when row has null coverUrl', () => {
    const mockCovers = new Map<string, string | null>();
    mockCovers.set('id0', null);
    hoisted.mockUseCoverWindowing.mockReturnValue(mockCovers);

    render(<MainContent {...baseProps} items={makeItems(3)} />);
    const cards = screen.getAllByTestId('song-card');
    expect(cards[0].querySelector('[data-testid="music-icon"]')).not.toBeNull();
    expect(cards[0].querySelector('img')).toBeNull();
  });
});
