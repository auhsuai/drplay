// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { getValidToken } from '../../../utils/apiClient';
import { captureError } from '../../../utils/errorLog';
import { usePlaybackEventListeners } from './usePlaybackEventListeners';
import type { Track } from '../../../App';
import type { TFunction } from 'i18next';
import type { MutableRefObject, RefObject } from 'react';
import type { PlayerAction } from '../types';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../../../utils/apiClient', () => ({
  getValidToken: vi.fn(),
}));

vi.mock('../../../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

const DRIVE_QUOTA_RETRY_MS = 30_000;

const listenMock = vi.mocked(listen);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedCaptureError = vi.mocked(captureError);

const unlistenFn = vi.fn();

let tokenExpiredHandler: (() => Promise<void>) | null = null;
let driveQuotaHandler: (() => void) | null = null;

function resetListenMock() {
  tokenExpiredHandler = null;
  driveQuotaHandler = null;
  listenMock.mockImplementation((event: string, handler: unknown) => {
    if (event === 'token-expired') {
      tokenExpiredHandler = handler as () => Promise<void>;
    }
    if (event === 'drive-quota-exceeded') {
      driveQuotaHandler = handler as () => void;
    }
    return Promise.resolve(unlistenFn);
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeTrack(): Track {
  return { id: 't1', title: 'Song', artist: 'Artist', streamUrl: 'https://example.com/stream' };
}

function makeArgs(track: Track | null, getActiveAudio: () => HTMLAudioElement | null = () => null) {
  const dispatch = vi.fn();
  const loadNormalAudio = vi.fn();
  const performRetry = vi.fn();
  const onTogglePlay = vi.fn();
  return {
    currentTrackRef: { current: track } as MutableRefObject<Track | null>,
    isPlayingRef: { current: true } as MutableRefObject<boolean>,
    errorInfoRef: { current: null } as MutableRefObject<{ type: string; text: string } | null>,
    errorPositionRef: { current: null } as MutableRefObject<number | null>,
    lastKnownPositionRef: { current: 120 } as MutableRefObject<number>,
    isTransitioningRef: { current: false } as MutableRefObject<boolean>,
    onTogglePlayRef: { current: onTogglePlay } as MutableRefObject<() => void>,
    dispatch,
    loadNormalAudio,
    performRetry,
    onTogglePlay,
    t: ((_key: string, fallback?: string) => fallback ?? _key) as TFunction,
    getActiveAudio,
    audioRef: { current: null } as RefObject<HTMLAudioElement | null>,
    audioRef2: { current: null } as RefObject<HTMLAudioElement | null>,
    activeAudioIndexRef: { current: 0 } as MutableRefObject<0 | 1>,
  };
}

function audioWithError(): HTMLAudioElement {
  return { currentTime: 10, error: new Error('decode') } as unknown as HTMLAudioElement;
}

function renderHookWith(args: ReturnType<typeof makeArgs>) {
  return renderHook(() => usePlaybackEventListeners(
    args.currentTrackRef,
    args.isPlayingRef,
    args.errorInfoRef,
    args.errorPositionRef,
    args.lastKnownPositionRef,
    args.isTransitioningRef,
    args.onTogglePlayRef,
    args.dispatch as unknown as React.Dispatch<PlayerAction>,
    args.t,
    args.getActiveAudio,
    args.loadNormalAudio,
    args.performRetry,
    args.audioRef,
    args.audioRef2,
    args.activeAudioIndexRef
  ));
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function fireTokenExpired() {
  if (!tokenExpiredHandler) throw new Error('token-expired handler not registered');
  await act(async () => {
    void tokenExpiredHandler!();
  });
}

function fireDriveQuota() {
  if (!driveQuotaHandler) throw new Error('drive-quota-exceeded handler not registered');
  act(() => {
    driveQuotaHandler!();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetListenMock();
  mockedGetValidToken.mockResolvedValue('test-token');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePlaybackEventListeners async-after-unmount', () => {
  it('does not dispatch ERROR after unmount when token refresh rejects while in flight', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tokenDeferred = deferred<string | null>();
    mockedGetValidToken.mockReturnValue(tokenDeferred.promise);

    const args = makeArgs(makeTrack());
    const { unmount } = renderHookWith(args);

    await fireTokenExpired();
    unmount();

    tokenDeferred.reject(new Error('network down'));
    await flushMicrotasks();

    expect(args.dispatch).not.toHaveBeenCalled();
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('does not call loadNormalAudio after unmount when token refresh resolves while in flight', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tokenDeferred = deferred<string | null>();
    mockedGetValidToken.mockReturnValue(tokenDeferred.promise);

    const args = makeArgs(makeTrack(), audioWithError);
    const { unmount } = renderHookWith(args);

    await fireTokenExpired();
    unmount();

    tokenDeferred.resolve('fresh-token');
    await flushMicrotasks();

    expect(args.loadNormalAudio).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not dispatch after unmount when the drive-quota retry resolves while in flight', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retryDeferred = deferred<void>();
    const args = makeArgs(makeTrack());
    args.performRetry.mockReturnValue(retryDeferred.promise);

    const { unmount } = renderHookWith(args);

    fireDriveQuota();
    expect(args.dispatch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DRIVE_QUOTA_RETRY_MS);
    expect(args.performRetry).toHaveBeenCalledTimes(1);

    unmount();

    retryDeferred.resolve();
    await flushMicrotasks();

    expect(args.dispatch).toHaveBeenCalledTimes(1);
    expect(args.performRetry).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('clears the drive-quota retry timer on unmount before it fires', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const args = makeArgs(makeTrack());
    const { unmount } = renderHookWith(args);

    fireDriveQuota();
    unmount();

    vi.advanceTimersByTime(DRIVE_QUOTA_RETRY_MS);

    expect(args.performRetry).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
