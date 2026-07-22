// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MainContent } from './MainContent';
import type { DriveItem } from '../../App';

// DO NOT mock @tanstack/react-virtual — we need the REAL virtualizer
// to catch the "initial count 0 → no items rendered" bug.

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

// jsdom limitation: HTMLElement.offsetHeight is always 0 because jsdom
// doesn't compute layout. The virtualizer's calculateRange bails out when
// outerSize === 0 (see @tanstack/virtual-core calculateRange). To test the
// real virtualizer's behavior when items transition from 0 to N, we override
// offsetHeight for <main> elements so the virtualizer sees a non-zero
// container height — simulating what a real browser provides via layout.
const origOffsetHeightDesc = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype, 'offsetHeight'
)!;

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

vi.mock('./components/SongCard', () => ({
  SongCard: vi.fn(({ item }: { item: DriveItem }) => (
    <div data-testid="song-card" data-item-id={item.id} />
  )),
}));

vi.mock('../../utils/driveApi', () => ({
  createFolder: vi.fn(),
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
}));

vi.mock('../../utils/simpleToast', () => ({
  showErrorToast: vi.fn(),
}));

vi.mock('../../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

vi.mock('../../ui/components/MoreMenu', () => ({
  MoreMenu: () => null,
}));

// jsdom has no ResizeObserver — polyfill it so the ResizeObserver-based
// remeasurement effect in MainContent doesn't throw during test setup.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);
vi.stubGlobal('requestAnimationFrame', ((fn: FrameRequestCallback) => {
  setTimeout(() => fn(0), 0);
  return 0;
}) as typeof requestAnimationFrame);

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
  items: [] as DriveItem[],
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

describe('MainContent virtualizer behavior with real @tanstack/react-virtual', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      get: function () {
        if ((this as HTMLElement).tagName === 'MAIN') return 800;
        return origOffsetHeightDesc.get!.call(this);
      },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origOffsetHeightDesc);
  });

  it('renders items when count transitions from 0 to N (pages=1, count < itemsPerPage)', () => {
    const { rerender } = render(<MainContent {...baseProps} />);

    // Initially empty — no song cards should render
    expect(screen.queryAllByTestId('song-card').length).toBe(0);

    // Simulate data arriving: items go from [] to 30 (< itemsPerPage=50)
    act(() => {
      rerender(<MainContent {...baseProps} items={makeItems(30)} />);
    });

    // Now items should appear — this is the regression test.
    // With the bug, the virtualizer returns 0 items even though count=30.
    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(50);
  });

  it('renders items when count transitions from 0 to N (pages>1, count=itemsPerPage)', () => {
    const { rerender } = render(<MainContent {...baseProps} />);

    expect(screen.queryAllByTestId('song-card').length).toBe(0);

    // Simulate data arriving: items go from [] to 50 (= itemsPerPage)
    act(() => {
      rerender(<MainContent {...baseProps} items={makeItems(50)} />);
    });

    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBeGreaterThan(0);
  });

  it('renders items when data arrives with delay (count 0, then 0, then N)', async () => {
    const { rerender } = render(<MainContent {...baseProps} />);
    expect(screen.queryAllByTestId('song-card').length).toBe(0);

    // Simulate a second render with still-empty items (like loading state)
    act(() => {
      rerender(<MainContent {...baseProps} />);
    });
    expect(screen.queryAllByTestId('song-card').length).toBe(0);

    // Now data arrives
    act(() => {
      rerender(<MainContent {...baseProps} items={makeItems(25)} />);
    });

    const cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBeGreaterThan(0);
  });

  it('renders items after multiple data transitions (0 → N → M)', () => {
    const { rerender } = render(<MainContent {...baseProps} />);
    expect(screen.queryAllByTestId('song-card').length).toBe(0);

    // First data arrival: 0 → 30
    act(() => {
      rerender(<MainContent {...baseProps} items={makeItems(30)} />);
    });
    let cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBeGreaterThan(0);

    // Update to a different count: 30 → 45 (still one page)
    act(() => {
      rerender(<MainContent {...baseProps} items={makeItems(45)} />);
    });
    cards = screen.getAllByTestId('song-card');
    expect(cards.length).toBeGreaterThan(0);

    // Verify first item is correct (regression: items should not be blank)
    const firstId = cards[0].getAttribute('data-item-id');
    expect(firstId).toBe('id0');
  });
});
