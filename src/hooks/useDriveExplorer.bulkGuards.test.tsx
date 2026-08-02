// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { db } from '../db/db';
import { useDriveExplorer } from './useDriveExplorer';
import { useDriveStore } from '../store/driveStore';
import { deleteFile, moveFile, driveFetch } from '../utils/driveApi';
import { isUploading, getUploadState } from '../utils/uploadManager';
import { showErrorToast } from '../utils/simpleToast';

// Network layer mocked (mirrors useDriveExplorer.fetchOnDemand.test.tsx);
// uploadManager/driveApi/simpleToast mocked so bulk guards can be asserted
// in isolation. Dexie stays real (fake-indexeddb).
vi.mock('../utils/apiClient', () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock('../utils/uploadManager', () => ({
  isUploading: vi.fn(),
  getUploadingIds: vi.fn(),
  getUploadState: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));
vi.mock('../utils/driveApi', () => ({
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
  createFolder: vi.fn(),
  driveFetch: vi.fn(),
}));
vi.mock('../utils/simpleToast', () => ({
  showErrorToast: vi.fn(),
}));

const mockedIsUploading = vi.mocked(isUploading);
const mockedDeleteFile = vi.mocked(deleteFile);
const mockedMoveFile = vi.mocked(moveFile);
const mockedShowErrorToast = vi.mocked(showErrorToast);
const mockedGetUploadState = vi.mocked(getUploadState);
const mockedDriveFetch = vi.mocked(driveFetch);

const FOLDER_ID = 'bulk-folder';
const TOKEN = 'bulk-token';

beforeEach(async () => {
  await db.files.clear();
  useDriveStore.setState({ isLoadingTracks: false });
  mockedIsUploading.mockReset();
  mockedIsUploading.mockReturnValue(false);
  mockedGetUploadState.mockReset();
  mockedGetUploadState.mockReturnValue('none');
  mockedDeleteFile.mockReset();
  mockedDeleteFile.mockResolvedValue({ id: 'x', name: 'x', mimeType: 'audio/mpeg', parents: [FOLDER_ID] });
  mockedMoveFile.mockReset();
  mockedMoveFile.mockResolvedValue({ id: 'x', name: 'x', mimeType: 'audio/mpeg', parents: [FOLDER_ID] });
  mockedShowErrorToast.mockReset();
  // fetchOnDemand runs on mount with the real token; a non-retryable 404 keeps
  // it out of the way (no retries, no real-time backoff).
  mockedDriveFetch.mockReset();
  mockedDriveFetch.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
});

afterEach(async () => {
  await db.files.clear();
});

function setupSelection(ids: string[]) {
  const { result } = renderHook(() => useDriveExplorer(FOLDER_ID, 'Folder', TOKEN, () => {}));
  act(() => {
    result.current.setSelectedIds(new Set(ids));
  });
  return result;
}

function uploadingId(id: string) {
  mockedIsUploading.mockImplementation((candidate: string) => candidate === id);
}

describe('useDriveExplorer bulk guard: upload-uploading items are never deleted', () => {
  it('skips uploading ids, deletes the rest, and toasts exactly once (mixed selection)', async () => {
    uploadingId('c');
    const result = setupSelection(['a', 'b', 'c']);
    const onComplete = vi.fn();

    await act(async () => {
      await result.current.handleBulkDelete(onComplete);
    });

    expect(mockedDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockedDeleteFile).toHaveBeenCalledWith(TOKEN, 'a');
    expect(mockedDeleteFile).toHaveBeenCalledWith(TOKEN, 'b');
    expect(mockedDeleteFile).not.toHaveBeenCalledWith(TOKEN, 'c');
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('returns early without deleting anything when every selected id is uploading', async () => {
    uploadingId('a');
    const result = setupSelection(['a']);
    const onComplete = vi.fn();

    await act(async () => {
      await result.current.handleBulkDelete(onComplete);
    });

    expect(mockedDeleteFile).not.toHaveBeenCalled();
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(result.current.selectedIds.has('a')).toBe(true);
    expect(result.current.isBulkOperating).toBe(false);
  });

  it('keeps the old behavior (no toast, no filtering) when nothing is uploading', async () => {
    const result = setupSelection(['a', 'b']);

    try {
      await act(async () => {
        await result.current.handleBulkDelete(vi.fn());
      });
    } catch (e) {
      console.log('REAL ERROR:', (e as Error).stack);
      throw e;
    }

    expect(mockedDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockedShowErrorToast).not.toHaveBeenCalled();
  });
});

describe('useDriveExplorer bulk guard: upload-uploading items are never moved', () => {
  it('skips uploading ids, moves the rest, and toasts exactly once (mixed selection)', async () => {
    uploadingId('b');
    const result = setupSelection(['a', 'b']);

    await act(async () => {
      await result.current.handleBulkMove('dest-folder', vi.fn());
    });

    expect(mockedMoveFile).toHaveBeenCalledTimes(1);
    expect(mockedMoveFile).toHaveBeenCalledWith(TOKEN, 'a', FOLDER_ID, 'dest-folder');
    expect(mockedMoveFile).not.toHaveBeenCalledWith(TOKEN, 'b', FOLDER_ID, 'dest-folder');
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
  });

  it('returns early without moving anything when every selected id is uploading', async () => {
    uploadingId('a');
    const result = setupSelection(['a']);

    await act(async () => {
      await result.current.handleBulkMove('dest-folder', vi.fn());
    });

    expect(mockedMoveFile).not.toHaveBeenCalled();
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(result.current.selectedIds.has('a')).toBe(true);
  });

  it('keeps the old behavior (no toast, no filtering) when nothing is uploading', async () => {
    const result = setupSelection(['a', 'b']);

    await act(async () => {
      await result.current.handleBulkMove('dest-folder', vi.fn());
    });

    expect(mockedMoveFile).toHaveBeenCalledTimes(2);
    expect(mockedShowErrorToast).not.toHaveBeenCalled();
  });
});
