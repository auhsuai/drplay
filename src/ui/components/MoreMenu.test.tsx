// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MoreMenu } from './MoreMenu';
import type { Track, DriveItem } from '../../App';

const mocks = vi.hoisted(() => ({
  driveApi: {
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
  },
  db: {
    files: { delete: vi.fn(), update: vi.fn() },
  },
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
  getPlaylists: vi.fn(),
  addTrackToPlaylist: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Keys without a defaultValue fallback in MoreMenu.tsx resolve to the
    // real key string via `t(key) || fallback`; map them to readable labels
    // so the assertions read naturally, everything else falls back as usual.
    t: (key: string, fallback?: string) =>
      ({
        'menu.select_multiple': 'Select Multiple',
        'drive.move_to': 'Move to...',
        'drive.delete': 'Delete',
        'menu.download': 'Download',
        'menu.add_to_playlist': 'Add to Playlist',
      })[key] ?? fallback ?? key,
  }),
}));

vi.mock('../../utils/driveApi', () => mocks.driveApi);
vi.mock('../../db/db', () => ({ db: mocks.db }));
vi.mock('../../utils/errorLog', () => ({ captureError: mocks.captureError }));
vi.mock('../../utils/simpleToast', () => ({ showErrorToast: mocks.showErrorToast }));
vi.mock('../../utils/playlists', () => ({
  getPlaylists: mocks.getPlaylists,
  addTrackToPlaylist: mocks.addTrackToPlaylist,
}));

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    title: 'My Song',
    artist: 'Artist',
    streamUrl: 'https://example.com/song',
    size: 1000,
    parentId: 'parent-1',
    parentName: 'Folder One',
    ...over,
  };
}

function makeDriveItem(over: Partial<DriveItem> = {}): DriveItem {
  return {
    id: 'track-1',
    title: 'My Song',
    isFolder: false,
    size: 1000,
    trackInfo: makeTrack(),
    ...over,
  };
}

function menuEl(): HTMLElement {
  const menu = document.body.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu as HTMLElement;
}

function openTrigger(): void {
  const trigger = document.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  fireEvent.click(trigger);
}

function menuButtonNames(): string[] {
  return within(menuEl()).getAllByRole('button').map((b) => b.textContent?.trim() ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPlaylists.mockResolvedValue([]);
  mocks.driveApi.deleteFile.mockResolvedValue({ id: 'track-1', name: 'My Song', mimeType: 'audio/mpeg', trashed: true, isFolder: false, parentId: 'parent-1' });
});

afterEach(() => {
  cleanup();
});

describe('MoreMenu recent variant', () => {
  it('shows exactly 4 curated items (Delete / Download Song / Add to Playlist / Navigate) and no Select Multiple or Move to', () => {
    render(<MoreMenu variant="recent" track={makeTrack()} driveItem={makeDriveItem()} token="tok" />);
    openTrigger();
    expect(menuButtonNames().sort()).toEqual(['Add to Playlist', 'Delete', 'Download Song', 'Navigate']);
    expect(within(menuEl()).queryByRole('button', { name: 'Select Multiple' })).toBeNull();
    expect(within(menuEl()).queryByRole('button', { name: 'Move to...' })).toBeNull();
  });

  it('hides Delete when token is missing but keeps track-based items', () => {
    render(<MoreMenu variant="recent" track={makeTrack()} driveItem={makeDriveItem()} />);
    openTrigger();
    expect(menuButtonNames().sort()).toEqual(['Add to Playlist', 'Download Song', 'Navigate']);
  });

  it('hides Delete when driveItem is missing (track-only render) but keeps track-based items', () => {
    render(<MoreMenu variant="recent" track={makeTrack()} token="tok" />);
    openTrigger();
    expect(menuButtonNames().sort()).toEqual(['Add to Playlist', 'Download Song', 'Navigate']);
  });

  it('dispatches the locate-file CustomEvent with fileId/parentId/parentName on Navigate', () => {
    const spy = vi.fn();
    window.addEventListener('locate-file', spy);
    const onClose = vi.fn();
    render(<MoreMenu variant="recent" track={makeTrack()} driveItem={makeDriveItem()} token="tok" onClose={onClose} />);
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole('button', { name: 'Navigate' }));
    expect(spy).toHaveBeenCalledTimes(1);
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ fileId: 'track-1', parentId: 'parent-1', parentName: 'Folder One' });
    expect(onClose).toHaveBeenCalled();
  });

  it('opens DeleteConfirmDialog on Delete and runs the delete path on confirm', async () => {
    const onRemoveItem = vi.fn();
    const onClose = vi.fn();
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        onRemoveItem={onRemoveItem}
        onClose={onClose}
      />,
    );
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Move to Trash?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.driveApi.deleteFile).toHaveBeenCalledWith('tok', 'track-1'));
    await waitFor(() => expect(mocks.db.files.delete).toHaveBeenCalledWith('track-1'));
    await waitFor(() => expect(onRemoveItem).toHaveBeenCalledWith('track-1'));
    expect(screen.queryByText('Move to Trash?')).toBeNull();
  });

  it('opens DownloadDialog on Download Song without crashing', () => {
    render(<MoreMenu variant="recent" track={makeTrack()} driveItem={makeDriveItem()} token="tok" />);
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole('button', { name: 'Download Song' }));
    expect(screen.getByText('Download File')).toBeTruthy();
  });

  it('opens PlaylistsSubmenu on Add to Playlist', () => {
    render(<MoreMenu variant="recent" track={makeTrack()} driveItem={makeDriveItem()} token="tok" />);
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole('button', { name: 'Add to Playlist' }));
    expect(screen.getByText('Playlists')).toBeTruthy();
  });
});

describe('MoreMenu default variant regression (file list)', () => {
  it('keeps the original 5 items (Select Multiple / Move to / Delete / Download / Add to Playlist)', () => {
    render(<MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />);
    openTrigger();
    expect(menuButtonNames().sort()).toEqual([
      'Add to Playlist',
      'Delete',
      'Download',
      'Move to...',
      'Select Multiple',
    ]);
  });

  it('keeps the original items even when variant is explicitly "default"', () => {
    render(<MoreMenu variant="default" track={makeTrack()} driveItem={makeDriveItem()} token="tok" />);
    openTrigger();
    expect(menuButtonNames().sort()).toEqual([
      'Add to Playlist',
      'Delete',
      'Download',
      'Move to...',
      'Select Multiple',
    ]);
  });
});

describe('MoreMenu playerbar variant regression', () => {
  it('keeps the original 2 track items (Download Song / Navigate) plus shared Add to Playlist, no Delete', () => {
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    expect(menuButtonNames().sort()).toEqual(['Add to Playlist', 'Download Song', 'Navigate']);
    expect(within(menuEl()).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(menuEl()).queryByRole('button', { name: 'Select Multiple' })).toBeNull();
  });

  it('still dispatches locate-file with the same detail as before', () => {
    const spy = vi.fn();
    window.addEventListener('locate-file', spy);
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole('button', { name: 'Navigate' }));
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ fileId: 'track-1', parentId: 'parent-1', parentName: 'Folder One' });
  });
});
