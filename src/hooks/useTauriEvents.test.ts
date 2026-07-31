// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { getValidToken } from '../utils/apiClient';
import { getTrackMetadata } from '../utils/metadata';
import type { CachedMetadata } from '../utils/metadata';
import { useTauriEvents } from './useTauriEvents';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../utils/apiClient', () => ({
  getValidToken: vi.fn(),
}));

vi.mock('../utils/metadata', () => ({
  getTrackMetadata: vi.fn(),
}));

const listenMock = vi.mocked(listen);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedGetTrackMetadata = vi.mocked(getTrackMetadata);

const unlistenFn = vi.fn();

let repairHandler: ((event: { payload: { driveFileId: string; dbId: string } }) => Promise<void>) | null = null;

function resetListenMock() {
  repairHandler = null;
  listenMock.mockImplementation((event: string, handler: unknown) => {
    if (event === 'repair-missing-thumbnail') {
      repairHandler = handler as (event: { payload: { driveFileId: string; dbId: string } }) => Promise<void>;
    }
    return Promise.resolve(unlistenFn);
  });
}

async function fireRepair(driveFileId = 'file-1', dbId = 'db-1') {
  if (!repairHandler) throw new Error('repair-missing-thumbnail handler not registered — mount the hook first');
  await act(async () => {
    await repairHandler!({ payload: { driveFileId, dbId } });
  });
}

const okResponse = { ok: true, status: 200 } as unknown as Response;

function metaWith(pictureData: Uint8Array | null, pictureDataFull: Uint8Array | null): CachedMetadata {
  return { pictureData, pictureDataFull, v: 10 } as CachedMetadata;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetListenMock();
  mockedGetValidToken.mockResolvedValue('test-token');
  mockedGetTrackMetadata.mockResolvedValue(metaWith(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useTauriEvents repair-missing-thumbnail cover upload', () => {
  it('passes an AbortSignal to both cover upload fetches (regression: signal was missing)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);

    renderHook(() => useTauriEvents(vi.fn()));
    await fireRepair();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const thumbCall = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    const fullCall = fetchMock.mock.calls[1] as [RequestInfo | URL, RequestInit?];
    expect(String(thumbCall[0])).toContain('/cover/db-1?thumb=true');
    expect(String(fullCall[0])).toContain('/cover/db-1?thumb=false');
    expect(thumbCall[1]?.signal).toBeDefined();
    expect(fullCall[1]?.signal).toBeDefined();
  });

  it('aborts the in-flight cover upload when the component unmounts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>(() => {})
    );

    const { unmount } = renderHook(() => useTauriEvents(vi.fn()));
    await act(async () => {
      void repairHandler!({ payload: { driveFileId: 'file-1', dbId: 'db-1' } });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeDefined();
    expect(init?.signal?.aborted).toBe(false);

    unmount();

    expect(init?.signal?.aborted).toBe(true);
  });

  it('bounds the cover upload with AbortSignal.timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);

    renderHook(() => useTauriEvents(vi.fn()));
    await fireRepair();

    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it('skips both cover uploads and still dispatches metadata-updated when metadata has no picture data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    mockedGetTrackMetadata.mockResolvedValue(metaWith(null, null));

    renderHook(() => useTauriEvents(vi.fn()));
    await fireRepair();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'metadata-updated' })
    );
  });

  it('skips uploads without crashing when there is no valid token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    mockedGetValidToken.mockResolvedValue(null);

    renderHook(() => useTauriEvents(vi.fn()));
    await fireRepair();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedGetTrackMetadata).not.toHaveBeenCalled();
  });

  it('does not log cover-upload-failed when the upload is deliberately aborted (AbortError)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    renderHook(() => useTauriEvents(vi.fn()));
    await fireRepair();

    const failedLogs = warnSpy.mock.calls.filter(call => String(call[0]).includes('cover-upload-failed'));
    expect(failedLogs).toHaveLength(0);
  });
});
