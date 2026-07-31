// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { DriveItem } from '../../App';
import { GlobalContextMenu } from './GlobalContextMenu';
import { fetchWithAuth } from '../../utils/apiClient';
import { getCustomDownloadPath, getEffectiveDownloadPath } from '../../utils/downloadPath';
import { getPlaylists } from '../../utils/playlists';
import { showErrorToast } from '../../utils/simpleToast';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('../../utils/apiClient', () => ({
  fetchWithAuth: vi.fn(),
  getValidToken: vi.fn(),
}));

vi.mock('../../utils/downloadPath', () => ({
  getEffectiveDownloadPath: vi.fn(),
  getCustomDownloadPath: vi.fn(),
}));

vi.mock('../../utils/playlists', () => ({
  getPlaylists: vi.fn(),
  addTrackToPlaylist: vi.fn(),
}));

vi.mock('../../utils/driveApi', () => ({
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
  searchFolders: vi.fn(),
  listFolderChildren: vi.fn(),
  getFileParents: vi.fn(),
  getFileName: vi.fn(),
}));

vi.mock('../../utils/simpleToast', () => ({
  showErrorToast: vi.fn(),
}));

vi.mock('../FolderSelection/FolderSelectionScreen', () => ({
  FolderSelectionScreen: () => null,
}));

const mockedInvoke = vi.mocked(invoke);
const mockedFetchWithAuth = vi.mocked(fetchWithAuth);
const mockedGetEffectiveDownloadPath = vi.mocked(getEffectiveDownloadPath);
const mockedGetCustomDownloadPath = vi.mocked(getCustomDownloadPath);
const mockedGetPlaylists = vi.mocked(getPlaylists);
const mockedShowErrorToast = vi.mocked(showErrorToast);

// Byte payload of the mocked Drive response blob. Uses 0 and 255 on purpose:
// a signed/unsigned mishap in the binary transport would corrupt these bytes.
const FILE_BYTES = [0, 255, 1, 128, 65];

function makeDriveItem(overrides: Partial<DriveItem> = {}): DriveItem {
  return {
    id: 'file-abc',
    title: 'My Song',
    isFolder: false,
    trackInfo: {
      id: 'file-abc',
      title: 'My Song',
      artist: 'Test Artist',
      streamUrl: 'https://example.com/my-song',
      originalName: 'my song.mp3',
    },
    ...overrides,
  };
}

function okResponseWithBlob(): Response {
  return {
    ok: true,
    blob: async () => new Blob([new Uint8Array(FILE_BYTES)]),
  } as unknown as Response;
}

async function openMenu(driveItem: DriveItem) {
  render(<GlobalContextMenu />);
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('show-context-menu', { detail: { x: 10, y: 10, driveItem } })
    );
  });
}

async function clickDownload() {
  const button = screen.getByRole('button', { name: 'Tải xuống' });
  await act(async () => {
    fireEvent.click(button);
  });
  // Flush the async handleDownload chain (fetch -> blob -> invoke).
  await act(async () => {});
  await act(async () => {});
}

function findInvokeCall(cmd: string) {
  return mockedInvoke.mock.calls.find(([c]) => c === cmd);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockedGetEffectiveDownloadPath.mockResolvedValue('C:\\Downloads');
  mockedGetCustomDownloadPath.mockReturnValue(null);
  mockedGetPlaylists.mockResolvedValue([]);
  mockedInvoke.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GlobalContextMenu download', () => {
  it('#6 regression: write_file invoke receives the raw bytes as a Uint8Array, not an Array.from number array', async () => {
    mockedFetchWithAuth.mockResolvedValue(okResponseWithBlob());

    await openMenu(makeDriveItem());
    await clickDownload();

    const writeCall = findInvokeCall('plugin:fs|write_file');
    expect(writeCall).toBeDefined();
    const [, payload, options] = writeCall!;

    // The regression: the payload used to be `Array.from(uint8Array)`, a JS
    // number array (~8 bytes/byte) that also forces JSON serialization.
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(Array.isArray(payload)).toBe(false);
    // Byte-exact round-trip (0 and 255 included).
    expect(Array.from(payload as Uint8Array)).toEqual(FILE_BYTES);

    // tauri-plugin-fs v2 write_file reads the target path from a request
    // header and takes the bytes as the raw body — this is the wire contract.
    expect(options).toEqual({
      headers: { path: encodeURIComponent('C:\\Downloads\\my song.mp3') },
    });
    // No custom path configured -> the fs scope extension must not be called.
    expect(findInvokeCall('register_download_path')).toBeUndefined();
  });

  it('variant: response not ok -> no write_file invoke, error state, no crash', async () => {
    mockedFetchWithAuth.mockResolvedValue({ ok: false, status: 403 } as Response);

    await openMenu(makeDriveItem());
    await clickDownload();

    expect(findInvokeCall('plugin:fs|write_file')).toBeUndefined();
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Lỗi tải xuống' })).toBeTruthy();
  });

  it('variant: write_file invoke rejects -> error state, no crash', async () => {
    mockedFetchWithAuth.mockResolvedValue(okResponseWithBlob());
    mockedInvoke.mockRejectedValueOnce(new Error('write failed'));

    await openMenu(makeDriveItem());
    await clickDownload();

    expect(findInvokeCall('plugin:fs|write_file')).toBeDefined();
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Lỗi tải xuống' })).toBeTruthy();
  });

  it('variant: custom download path extends the fs scope before writing (register_download_path first)', async () => {
    mockedGetEffectiveDownloadPath.mockResolvedValue('D:\\Music');
    mockedGetCustomDownloadPath.mockReturnValue('D:\\Music');
    mockedFetchWithAuth.mockResolvedValue(okResponseWithBlob());

    await openMenu(makeDriveItem());
    await clickDownload();

    const calls = mockedInvoke.mock.calls;
    const scopeCallIdx = calls.findIndex(([c]) => c === 'register_download_path');
    const writeCallIdx = calls.findIndex(([c]) => c === 'plugin:fs|write_file');
    expect(scopeCallIdx).toBeGreaterThanOrEqual(0);
    expect(writeCallIdx).toBeGreaterThan(scopeCallIdx);
    expect(calls[scopeCallIdx][1]).toEqual({ path: 'D:\\Music' });
    expect(calls[writeCallIdx][2]).toEqual({
      headers: { path: encodeURIComponent('D:\\Music\\my song.mp3') },
    });
  });
});
