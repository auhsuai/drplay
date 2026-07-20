// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MainContent } from './MainContent';
import type { DriveItem } from '../../App';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({
      index: i,
      key: i,
      size: 92,
      start: i * 92,
    })),
    getTotalSize: () => count * 92,
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

// Capture the coverUrl prop MainContent passes down to each SongCard.
const receivedCoverUrls: Array<string | null | undefined> = [];
vi.mock('./components/SongCard', () => ({
  SongCard: vi.fn(({ item, coverUrl }: { item: DriveItem; coverUrl?: string | null }) => {
    receivedCoverUrls.push(coverUrl);
    return <div data-testid="song-card" data-item-id={item.id} />;
  }),
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

describe('MainContent cover windowing layer', () => {
  beforeEach(() => {
    receivedCoverUrls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('coverUrl may be passed from batch fetch layer or undefined (mock)', () => {
    render(<MainContent {...baseProps} items={makeItems(3)} />);
    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBe(3);
    // With invoke mocked to return null, coverUrl will be undefined,
    // but the batch-fetch effect should fire without error.
    expect(() => render(<MainContent {...baseProps} items={makeItems(3)} />)).not.toThrow();
  });
});
