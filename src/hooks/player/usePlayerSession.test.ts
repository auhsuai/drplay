// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from '../../db/kv';
import { getValidToken } from '../../utils/apiClient';
import { getPrefetchedStreamUrl } from '../../utils/streamPrefetcher';
import { captureError } from '../../utils/errorLog';
import { usePlayerSession } from './usePlayerSession';
import type { Track } from '../../types';

vi.mock('../../db/kv', () => ({
  get: vi.fn(),
}));

vi.mock('../../utils/apiClient', () => ({
  getValidToken: vi.fn(),
}));

vi.mock('../../utils/streamPrefetcher', () => ({
  getPrefetchedStreamUrl: vi.fn(),
}));

vi.mock('../../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

const audioMock = vi.hoisted(() => ({
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 0),
  on: vi.fn(() => () => {}),
}));

vi.mock('../../lib/AudioController', () => ({
  AudioController: { getInstance: () => audioMock },
}));

vi.mock('../../store/playerStore', () => ({
  usePlayerStore: { getState: vi.fn(() => ({ currentTrack: null })) },
}));

const mockedGet = vi.mocked(get);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedGetPrefetchedStreamUrl = vi.mocked(getPrefetchedStreamUrl);
const mockedCaptureError = vi.mocked(captureError);

const SESSION_STORAGE_KEY = 'drplay_last_session';
const QUEUE_STORAGE_KEY = 'drplay_queue';
const PLAYMODE_STORAGE_KEY = 'drplay_playmode';

function makeTrack(id: string, queueItemId?: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: 'Artist',
    streamUrl: `https://stream.example/${id}`,
    ...(queueItemId ? { queueItemId } : {}),
  };
}

function makeHook() {
  const setCurrentTrack = vi.fn();
  const setOriginalQueue = vi.fn();
  const setPlaybackQueue = vi.fn();
  const setPlayMode = vi.fn();
  const triggerReload = vi.fn();
  renderHook(() =>
    usePlayerSession(setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, triggerReload)
  );
  return { setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, triggerReload };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedGet.mockResolvedValue(undefined);
  mockedGetValidToken.mockResolvedValue('test-token');
  mockedGetPrefetchedStreamUrl.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePlayerSession restore (lock-behavior)', () => {
  it('A: không có session (localStorage rỗng + kv null) → không set state, không reload', async () => {
    makeHook();
    await flushMicrotasks();

    expect(mockedGet).toHaveBeenCalledWith(SESSION_STORAGE_KEY);
    expect(mockedGetValidToken).not.toHaveBeenCalled();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it('B: có session localStorage + kv queue + playmode shuffle → restore track + queue shuffle qua helper (head = restored track, đủ phần tử)', async () => {
    const queue = [makeTrack('t1', 'q1'), makeTrack('t2', 'q2'), makeTrack('t3', 'q3')];
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ track: queue[0], time: 12, duration: 240 }));
    mockedGet.mockImplementation((key: string) => {
      if (key === QUEUE_STORAGE_KEY) return Promise.resolve(queue);
      if (key === PLAYMODE_STORAGE_KEY) return Promise.resolve('shuffle');
      return Promise.resolve(undefined);
    });

    const { setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, triggerReload } = makeHook();
    // Deterministic Fisher-Yates: Math.random=0 → shuffle = reverse, cho queue còn lại [t2,t3]
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await flushMicrotasks();

    const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
    expect(restored.id).toBe('t1');
    expect(restored.streamUrl).toBe('/drive-stream/t1');
    expect(restored.restoreTime).toBe(12);
    expect(restored.restoreDuration).toBe(240);
    expect(restored.queueItemId).toBe('q1');

    expect(setOriginalQueue).toHaveBeenCalledWith(queue);

    const shuffled = setPlaybackQueue.mock.calls[0]?.[0] as Track[];
    expect(shuffled).toHaveLength(3);
    expect(shuffled[0]).toBe(queue[0]);
    expect(shuffled.map((t) => t.id)).toEqual(['t1', 't3', 't2']);

    expect(setPlayMode).toHaveBeenCalledWith('shuffle');
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });

  it('C: abort giữa restore (getValidToken reject AbortError) → không set state, không captureError', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ track: makeTrack('t1', 'q1'), time: 5, duration: 100 }));
    mockedGetValidToken.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const { setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, triggerReload } = makeHook();
    await flushMicrotasks();

    expect(setCurrentTrack).not.toHaveBeenCalled();
    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlaybackQueue).not.toHaveBeenCalled();
    expect(setPlayMode).not.toHaveBeenCalled();
    expect(triggerReload).not.toHaveBeenCalled();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it('D: session corrupt (JSON sai) → fallback kv + vẫn restore đủ, không crash', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'not-valid-json{{{');
    const session = { track: makeTrack('t1', 'q1'), time: 9, duration: 90 };
    mockedGet.mockImplementation((key: string) => {
      if (key === SESSION_STORAGE_KEY) return Promise.resolve(session);
      return Promise.resolve(undefined);
    });

    const { setCurrentTrack, setOriginalQueue, setPlaybackQueue, setPlayMode, triggerReload } = makeHook();
    await flushMicrotasks();

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'usePlayerSession',
        message: expect.stringContaining('session-corrupt'),
      })
    );

    const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
    expect(restored.id).toBe('t1');
    expect(restored.restoreTime).toBe(9);
    expect(restored.restoreDuration).toBe(90);

    const playback = setPlaybackQueue.mock.calls[0]?.[0] as Track[];
    expect(playback).toHaveLength(1);
    expect(playback[0].id).toBe('t1');

    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlayMode).not.toHaveBeenCalled();
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });
});
