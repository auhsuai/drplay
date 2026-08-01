import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { refreshTokenAndRetry, toDriveFileRow } from './proSync.worker';
import type { SyncRetryState } from './proSync.worker';

describe('toDriveFileRow', () => {
  it('maps a folder to a row with isFolder=true and the folder MIME type', () => {
    const row = toDriveFileRow(
      {
        id: 'folder1',
        name: 'My Folder',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['parent1'],
        size: '1024',
        modifiedTime: '2026-01-01T00:00:00.000Z',
      },
      true
    );
    expect(row.isFolder).toBe(true);
    expect(row.mimeType).toBe('application/vnd.google-apps.folder');
  });

  it('maps a regular audio file to a row with isFolder=false', () => {
    const row = toDriveFileRow(
      {
        id: 'file1',
        name: 'song.mp3',
        mimeType: 'audio/mpeg',
        parents: ['parent1'],
        size: '2048',
        modifiedTime: '2026-01-02T00:00:00.000Z',
      },
      false
    );
    expect(row.isFolder).toBe(false);
    expect(row.mimeType).toBe('audio/mpeg');
  });

  it('falls back to parentId "root" when parents is missing or empty', () => {
    const noParents = toDriveFileRow({ id: 'a', name: 'a.mp3', mimeType: 'audio/mpeg' }, false);
    expect(noParents.parentId).toBe('root');

    const emptyParents = toDriveFileRow(
      { id: 'b', name: 'b.mp3', mimeType: 'audio/mpeg', parents: [] },
      false
    );
    expect(emptyParents.parentId).toBe('root');
  });

  it('uses the first parent as parentId when parents is present', () => {
    const row = toDriveFileRow(
      { id: 'c', name: 'c.mp3', mimeType: 'audio/mpeg', parents: ['p1', 'p2'] },
      false
    );
    expect(row.parentId).toBe('p1');
  });

  it('converts size via toSize and keeps modifiedTime/trashed as-is', () => {
    const row = toDriveFileRow(
      {
        id: 'd',
        name: 'd.mp3',
        mimeType: 'audio/mpeg',
        parents: ['p1'],
        size: '1048576',
        modifiedTime: '2026-01-03T00:00:00.000Z',
      },
      false
    );
    expect(row.size).toBe(1048576);
    expect(row.modifiedTime).toBe('2026-01-03T00:00:00.000Z');
    expect(row.trashed).toBe(false);
  });

  it('normalizes an empty/invalid size to undefined', () => {
    expect(toDriveFileRow({ id: 'e', name: 'e.mp3', mimeType: 'audio/mpeg', size: '' }, false).size).toBeUndefined();
    expect(toDriveFileRow({ id: 'f', name: 'f.mp3', mimeType: 'audio/mpeg' }, false).size).toBeUndefined();
    expect(toDriveFileRow({ id: 'g', name: 'g.mp3', mimeType: 'audio/mpeg', size: 'not-a-number' }, false).size).toBeUndefined();
  });

  it('produces the exact DB row shape used by full-sync and delta-sync', () => {
    const row = toDriveFileRow(
      {
        id: 'h',
        name: 'h.flac',
        mimeType: 'audio/flac',
        parents: ['p9'],
        size: '42',
        modifiedTime: '2026-01-04T00:00:00.000Z',
      },
      false
    );
    expect(row).toEqual({
      id: 'h',
      name: 'h.flac',
      mimeType: 'audio/flac',
      parentId: 'p9',
      size: 42,
      modifiedTime: '2026-01-04T00:00:00.000Z',
      trashed: false,
      isFolder: false,
    });
  });
});

describe('refreshTokenAndRetry', () => {
  function makeState(count: number, max: number): SyncRetryState {
    return { count, max };
  }

  function makeDeps(waitResult: boolean) {
    const sent: Array<{ type: string }> = [];
    let waitCalls = 0;
    const deps = {
      postMessage: (msg: { type: string }) => { sent.push(msg); },
      waitForTokenRefresh: async () => { waitCalls++; return waitResult; },
    };
    return { deps, sent, waitCalls: () => waitCalls };
  }

  it('gives up when count is already at max: returns false and posts SYNC_ERROR, no TOKEN_EXPIRED, no wait', async () => {
    const state = makeState(3, 3);
    const { deps, sent, waitCalls } = makeDeps(true);

    const result = await refreshTokenAndRetry(state, deps, 'full-sync/startPageToken');

    expect(result).toBe(false);
    expect(sent).toEqual([{ type: 'SYNC_ERROR' }]);
    expect(waitCalls()).toBe(0);
    expect(state.count).toBe(3);
  });

  it('still has retries: posts TOKEN_EXPIRED and waits for a token refresh', async () => {
    const state = makeState(0, 3);
    const { deps, sent, waitCalls } = makeDeps(true);

    const result = await refreshTokenAndRetry(state, deps, 'full-sync/files');

    expect(sent).toEqual([{ type: 'TOKEN_EXPIRED' }]);
    expect(waitCalls()).toBe(1);
    expect(result).toBe(true);
  });

  it('on successful refresh: resets the retry count to 0 and returns true', async () => {
    const state = makeState(1, 3);
    const { deps, sent, waitCalls } = makeDeps(true);

    const result = await refreshTokenAndRetry(state, deps, 'delta-sync/changes');

    expect(result).toBe(true);
    expect(waitCalls()).toBe(1);
    expect(state.count).toBe(0);
    expect(sent).toEqual([{ type: 'TOKEN_EXPIRED' }]);
  });

  it('on failed refresh: returns false without resetting the count', async () => {
    const state = makeState(2, 3);
    const { deps, sent, waitCalls } = makeDeps(false);

    const result = await refreshTokenAndRetry(state, deps, 'delta-sync/changes');

    expect(result).toBe(false);
    expect(waitCalls()).toBe(1);
    expect(state.count).toBe(3);
    expect(sent).toEqual([{ type: 'TOKEN_EXPIRED' }]);
  });

  it('does not post SYNC_ERROR on the retry path even when refresh fails', async () => {
    const state = makeState(0, 3);
    const { deps, sent } = makeDeps(false);

    const result = await refreshTokenAndRetry(state, deps, 'full-sync/files');

    expect(result).toBe(false);
    expect(sent).toEqual([{ type: 'TOKEN_EXPIRED' }]);
  });
});
