// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeTab } from './HomeTab';
import type { Track, UserProfile } from '../../types';
import type { DriveFileItem } from '../../utils/driveApi';
import { SYNC_EVENT_NAMES } from '../../utils/proSyncManager';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key, i18n: { language: 'en' } }),
}));

vi.mock('lucide-react', () => {
  const icons = ['Clock', 'Sparkles', 'Folder', 'Repeat', 'PlusCircle'];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  getRecentlyPlayed: vi.fn(),
  getHeavyRotation: vi.fn(),
  getRandomDiscoveries: vi.fn(),
  getMostVisitedFolders: vi.fn(),
  getRecentlyAddedAudioFiles: vi.fn(),
  captureError: vi.fn(),
  prefetchVisibleTracks: vi.fn(),
}));

vi.mock('../../utils/history', () => ({
  getRecentlyPlayed: mocks.getRecentlyPlayed,
  getHeavyRotation: mocks.getHeavyRotation,
  getRandomDiscoveries: mocks.getRandomDiscoveries,
  getMostVisitedFolders: mocks.getMostVisitedFolders,
}));
vi.mock('../../utils/driveApi', () => ({ getRecentlyAddedAudioFiles: mocks.getRecentlyAddedAudioFiles }));
vi.mock('../../utils/errorLog', () => ({ captureError: mocks.captureError }));
vi.mock('../../utils/streamPrefetcher', () => ({ prefetchVisibleTracks: mocks.prefetchVisibleTracks }));
vi.mock('../../hooks/useResponsiveItems', () => ({ useResponsiveItems: () => 5 }));
// Child components pull in metadata fetching / virtualized lists — stand-ins
// keep the HomeTab slice under test focused on section-level behavior. The
// PremiumCard stub renders the track title so data assertions stay readable.
vi.mock('./components/PremiumCard', () => ({
  PremiumCard: ({ track }: { track: Track }) => <div data-testid="premium-card">{track.title}</div>,
}));
vi.mock('./components/FullRecentView', () => ({
  FullRecentView: () => null,
}));

interface HomeTabProps {
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  onOpenFolder: (id: string, name: string) => void;
  token: string | null;
  userProfile?: UserProfile;
  currentTrack?: Track | null;
}

function baseProps(over: Partial<HomeTabProps> = {}): HomeTabProps {
  return {
    onPlay: () => {},
    onOpenFolder: () => {},
    token: 'tok-1',
    ...over,
  };
}

function driveFile(over: Partial<DriveFileItem> = {}): DriveFileItem {
  return { id: 'f-1', name: 'Song.mp3', mimeType: 'audio/mpeg', ...over };
}

const DRIVE_FILES_CHANGED = 'drive-files-changed';

describe('HomeTab Recently Added delta sync', () => {
  beforeEach(() => {
    mocks.getRecentlyPlayed.mockResolvedValue([]);
    mocks.getHeavyRotation.mockResolvedValue([]);
    mocks.getRandomDiscoveries.mockResolvedValue([]);
    mocks.getMostVisitedFolders.mockResolvedValue([]);
    mocks.getRecentlyAddedAudioFiles.mockReset();
    mocks.captureError.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('1. fetches recently added once on mount and renders the section with tracks', async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([driveFile({ id: 'a', name: 'First.mp3' })]);
    render(<HomeTab {...baseProps()} />);

    expect(await screen.findByText('First.mp3')).toBeTruthy();
    expect(screen.getByText('Recently Added to Drive')).toBeTruthy();
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1);
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledWith('tok-1');
  });

  it('2. refetches ONLY recently added (not the whole loadData) on drive-files-changed', async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([driveFile({ id: 'a', name: 'First.mp3' })]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText('First.mp3');
    expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);

    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([driveFile({ id: 'b', name: 'Second.mp3' })]);
    act(() => {
      window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED, { detail: { count: 1 } }));
    });

    expect(await screen.findByText('Second.mp3')).toBeTruthy();
    expect(screen.queryByText('First.mp3')).toBeNull();
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
    // Delta sync must not re-run the heavy local loads.
    expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);
  });

  it('3. generation guard: stale response never overwrites the newest one (3 overlapping fetches)', async () => {
    const deferred: Array<{ resolve: (v: DriveFileItem[]) => void }> = [];
    mocks.getRecentlyAddedAudioFiles
      .mockReturnValueOnce(new Promise((resolve) => { deferred.push({ resolve }); }))
      .mockReturnValueOnce(new Promise((resolve) => { deferred.push({ resolve }); }))
      .mockReturnValueOnce(new Promise((resolve) => { deferred.push({ resolve }); }));
    render(<HomeTab {...baseProps()} />);
    await waitFor(() => expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1));

    act(() => { window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED)); });
    await waitFor(() => expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2));
    act(() => { window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED)); });
    await waitFor(() => expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(3));

    // Newest request resolves FIRST with fresh data.
    await act(async () => { deferred[2].resolve([driveFile({ id: 'c', name: 'Newest.mp3' })]); });
    expect(await screen.findByText('Newest.mp3')).toBeTruthy();

    // Older responses arrive later — they must be dropped, not applied.
    await act(async () => { deferred[1].resolve([driveFile({ id: 'b', name: 'Middle.mp3' })]); });
    await act(async () => { deferred[0].resolve([driveFile({ id: 'a', name: 'Oldest.mp3' })]); });

    expect(screen.queryByText('Middle.mp3')).toBeNull();
    expect(screen.queryByText('Oldest.mp3')).toBeNull();
    expect(screen.getByText('Newest.mp3')).toBeTruthy();
  });

  it('4. does not fetch when token is null, even after drive-files-changed', async () => {
    render(<HomeTab {...baseProps({ token: null })} />);
    await waitFor(() => expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1));

    act(() => { window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED)); });
    await waitFor(() => expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(0));
    expect(mocks.getRecentlyAddedAudioFiles).not.toHaveBeenCalled();
    expect(screen.queryByText('Recently Added to Drive')).toBeNull();
  });

  it('5. fetch rejection: captureError logged and previous state kept', async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([driveFile({ id: 'a', name: 'First.mp3' })]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText('First.mp3');

    mocks.getRecentlyAddedAudioFiles.mockRejectedValue(new Error('network down'));
    act(() => { window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED)); });
    await waitFor(() => expect(mocks.captureError).toHaveBeenCalledTimes(1));

    expect(mocks.captureError.mock.calls[0][0].source).toBe('HomeTab');
    expect(mocks.captureError.mock.calls[0][0].level).toBe('warn');
    expect(mocks.captureError.mock.calls[0][0].message).toContain('failed-to-load-recently-added');
    // Old data must survive a failed refetch.
    expect(screen.getByText('First.mp3')).toBeTruthy();
  });

  it('6. unmount removes the listener: firing drive-files-changed afterwards does nothing', async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    const { unmount } = render(<HomeTab {...baseProps()} />);
    await waitFor(() => expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1));

    unmount();
    const callsBefore = mocks.getRecentlyAddedAudioFiles.mock.calls.length;
    act(() => { window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED)); });
    expect(mocks.getRecentlyAddedAudioFiles.mock.calls.length).toBe(callsBefore);
  });

  it('7. recent-updated still runs the full loadData (getRecentlyPlayed re-fetches)', async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    render(<HomeTab {...baseProps()} />);
    await waitFor(() => expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1));

    act(() => { window.dispatchEvent(new Event('recent-updated')); });
    await waitFor(() => expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(2));
  });

  it('8. rerender does not register duplicate drive-files-changed listeners', async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    const { rerender } = render(<HomeTab {...baseProps()} />);
    await waitFor(() => expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1));

    rerender(<HomeTab {...baseProps({ userProfile: { name: 'X', email: 'x@y.z', picture: '' } })} />);
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(1);

    act(() => { window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED)); });
    await waitFor(() => expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2));
    // A duplicate listener would have pushed this to 3.
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
  });

  it('9. hides the section when a refetch returns no audio files', async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([driveFile({ id: 'a', name: 'First.mp3' })]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText('First.mp3');
    expect(screen.getByText('Recently Added to Drive')).toBeTruthy();

    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([]);
    act(() => { window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED)); });
    await waitFor(() => expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2));

    expect(screen.queryByText('Recently Added to Drive')).toBeNull();
  });

  it('10. refetches recently added when pro-sync-complete fires (sync worker detected new Drive files)', async () => {
    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([driveFile({ id: 'a', name: 'First.mp3' })]);
    render(<HomeTab {...baseProps()} />);
    await screen.findByText('First.mp3');
    expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);

    mocks.getRecentlyAddedAudioFiles.mockResolvedValue([driveFile({ id: 'b', name: 'Second.mp3' })]);
    act(() => {
      window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAMES.complete));
    });

    expect(await screen.findByText('Second.mp3')).toBeTruthy();
    expect(screen.queryByText('First.mp3')).toBeNull();
    expect(mocks.getRecentlyAddedAudioFiles).toHaveBeenCalledTimes(2);
    // Delta sync must not re-run the heavy local loads.
    expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1);
  });

  it('11. pro-sync-complete with null token does not fetch', async () => {
    render(<HomeTab {...baseProps({ token: null })} />);
    await waitFor(() => expect(mocks.getRecentlyPlayed).toHaveBeenCalledTimes(1));

    act(() => { window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAMES.complete)); });
    expect(mocks.getRecentlyAddedAudioFiles).not.toHaveBeenCalled();
    expect(screen.queryByText('Recently Added to Drive')).toBeNull();
  });
});
