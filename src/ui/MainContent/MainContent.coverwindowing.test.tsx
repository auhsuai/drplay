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

// Capture the coverUrl prop MainContent passes down to each SongCard.
const receivedCoverUrls: Array<string | null | undefined> = [];
vi.mock('./components/SongCard', () => ({
  SongCard: vi.fn(({ item, coverUrl }: { item: DriveItem; coverUrl?: string | null }) => {
    receivedCoverUrls.push(coverUrl);
    return <div data-testid="song-card" data-item-id={item.id} />;
  }),
}));

// Mock the windowing layer: it resolves a cover for the two visible items.
vi.mock('../../hooks/useCoverWindowing', () => ({
  useCoverWindowing: vi.fn(() => {
    const m = new Map<string, string | null>();
    m.set('id0', 'http://localhost/cover/id0');
    m.set('id1', 'http://localhost/cover/id1');
    return m;
  }),
  PREFETCH_MARGIN_SLOW: 3,
  PREFETCH_MARGIN_MED: 6,
  PREFETCH_MARGIN_FAST: 12,
  VELOCITY_FAST_THRESHOLD: 100,
  VELOCITY_MED_THRESHOLD: 40,
  EVICT_MULTIPLIER: 2,
}));

vi.mock('../../hooks/useScrollVelocity', () => ({
  useScrollVelocity: () => ({ velocity: 0, dynamicMargin: 6 }),
}));

const hoisted = vi.hoisted(() => {
  const getVirtualItems = vi.fn<() => { key: number; index: number; start: number; size: number }[]>();
  const getTotalSize = vi.fn<() => number>();
  return {
    getVirtualItems,
    getTotalSize,
    useVirtualizer: vi.fn(() => ({
      getVirtualItems,
      getTotalSize,
    })),
  };
});

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: hoisted.useVirtualizer,
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

describe('MainContent cover windowing integration', () => {
  beforeEach(() => {
    receivedCoverUrls.length = 0;
    hoisted.getVirtualItems.mockReset();
    hoisted.getTotalSize.mockReset();
    hoisted.getVirtualItems.mockReturnValue([
      { key: 0, index: 0, start: 0, size: 92 },
      { key: 1, index: 1, start: 92, size: 92 },
    ]);
    hoisted.getTotalSize.mockReturnValue(4600);
  });

  afterEach(() => {
    cleanup();
  });

  it('injects windowed coverUrl into SongCard instead of letting each card self-fetch', () => {
    render(<MainContent {...baseProps} items={makeItems(50)} />);
    // Only the 2 virtualized rows are rendered.
    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBe(2);
    // Each visible card must receive a coverUrl from the windowing layer,
    // proving MainContent is wired to useCoverWindowing (the fix for the
    // RAM spike / high CPU on the My Drive tab).
    expect(receivedCoverUrls).toContain('http://localhost/cover/id0');
    expect(receivedCoverUrls).toContain('http://localhost/cover/id1');
  });
});
