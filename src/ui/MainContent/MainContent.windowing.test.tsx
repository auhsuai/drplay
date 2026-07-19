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

describe('MainContent virtualized rendering', () => {
  beforeEach(() => {
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

  it('only renders virtualized (visible) rows, not all items', () => {
    render(<MainContent {...baseProps} items={makeItems(50)} />);
    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBe(2);
    expect(cards.length).toBeLessThan(50);
  });
});
