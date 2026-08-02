// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ensureQueueItemId, sameTrack, shuffleQueueWithCurrent, usePlayerQueue } from './usePlayerQueue';
import type { PlayMode, Track } from '../../types';
import { set as idbSet } from '../../db/kv';
import { SESSION_CLEANUP_KEYS } from '../../utils/sessionCleanup';

vi.mock('../../db/kv', () => ({
  set: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

const baseTrack: Track = {
  id: 't1',
  title: 'Title',
  artist: 'Artist',
  streamUrl: 'https://stream.example/t1',
};

const makeTrack = (id: string): Track => ({ ...baseTrack, id });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('ensureQueueItemId', () => {
  it('trả về track cũ (không clone, giữ nguyên queueItemId) khi đã có queueItemId', () => {
    const track: Track = { ...baseTrack, queueItemId: 'existing-id' };
    const result = ensureQueueItemId(track);
    expect(result).toBe(track);
    expect(result.queueItemId).toBe('existing-id');
  });

  it('clone + gán queueItemId UUID mới khi chưa có queueItemId', () => {
    const result = ensureQueueItemId(baseTrack);
    expect(result).not.toBe(baseTrack);
    expect(result.queueItemId).toBeTypeOf('string');
    expect(result.queueItemId).toMatch(UUID_RE);
    expect(result.id).toBe('t1');
    expect(baseTrack.queueItemId).toBeUndefined();
  });
});

describe('sameTrack', () => {
  it('cả 2 có queueItemId → true khi queueItemId khớp dù id khác', () => {
    const a: Track = { ...baseTrack, id: 't1', queueItemId: 'q1' };
    const b: Track = { ...baseTrack, id: 't2', queueItemId: 'q1' };
    expect(sameTrack(a, b)).toBe(true);
  });

  it('cả 2 có queueItemId → false khi queueItemId khác dù id giống', () => {
    const a: Track = { ...baseTrack, id: 't1', queueItemId: 'q1' };
    const b: Track = { ...baseTrack, id: 't1', queueItemId: 'q2' };
    expect(sameTrack(a, b)).toBe(false);
  });

  it('1 bên thiếu queueItemId → so theo id', () => {
    const a: Track = { ...baseTrack, id: 't1', queueItemId: 'q1' };
    const b: Track = { ...baseTrack, id: 't1' };
    expect(sameTrack(a, b)).toBe(true);
    expect(sameTrack(b, a)).toBe(true);
    const c: Track = { ...baseTrack, id: 't2' };
    expect(sameTrack(a, c)).toBe(false);
  });

  it('cả 2 thiếu queueItemId → so theo id', () => {
    const a: Track = { ...baseTrack, id: 't1' };
    const b: Track = { ...baseTrack, id: 't1' };
    const c: Track = { ...baseTrack, id: 't2' };
    expect(sameTrack(a, b)).toBe(true);
    expect(sameTrack(a, c)).toBe(false);
  });
});

describe('handleTogglePlayMode', () => {
  const setup = (playMode: PlayMode, originalQueue: Track[], currentTrack: Track | null) => {
    const setPlaybackQueue = vi.fn();
    const setOriginalQueue = vi.fn();
    const setPlayMode = vi.fn();
    const handlePlayTrack = vi.fn();

    const { result, rerender } = renderHook(
      ({ pm, oq, ct }: { pm: PlayMode; oq: Track[]; ct: Track | null }) =>
        usePlayerQueue(ct, [], oq, pm, setPlaybackQueue, setOriginalQueue, setPlayMode, handlePlayTrack),
      { initialProps: { pm: playMode, oq: originalQueue, ct: currentTrack } }
    );

    const toggle = (): PlayMode => {
      act(() => { result.current.handleTogglePlayMode(); });
      const calls = setPlayMode.mock.calls;
      const nextMode = calls[calls.length - 1]?.[0] as PlayMode;
      rerender({ pm: nextMode, oq: originalQueue, ct: currentTrack });
      return nextMode;
    };

    const lastCall = (mock: ReturnType<typeof vi.fn>): unknown => {
      const calls = mock.mock.calls;
      return calls[calls.length - 1]?.[0];
    };

    return { toggle, setPlaybackQueue, setPlayMode, lastCall };
  };

  it('toggle 4 lần → cycle đủ 4 mode đúng thứ tự normal→shuffle→repeat-all→repeat-one→normal', () => {
    const { toggle } = setup('normal', [], null);
    const seen: PlayMode[] = [];
    for (let i = 0; i < 4; i++) seen.push(toggle());
    expect(seen).toEqual(['shuffle', 'repeat-all', 'repeat-one', 'normal']);
  });

  it('vào shuffle với queue > 0 → queue bị shuffle: đủ phần tử, track hiện tại ở đầu, thứ tự đổi', () => {
    const queue = [makeTrack('t1'), makeTrack('t2'), makeTrack('t3')];
    const { toggle, setPlaybackQueue, setPlayMode, lastCall } = setup('normal', queue, queue[2]);

    expect(toggle()).toBe('shuffle');

    const shuffled = lastCall(setPlaybackQueue) as Track[];
    expect(shuffled).toHaveLength(3);
    expect(new Set(shuffled.map(t => t.id))).toEqual(new Set(['t1', 't2', 't3']));
    expect(shuffled[0].id).toBe('t3');
    expect(shuffled.map(t => t.id)).not.toEqual(['t1', 't2', 't3']);
    expect(lastCall(setPlayMode)).toBe('shuffle');
  });

  it('rời shuffle → queue restore về thứ tự gốc', () => {
    const queue = [makeTrack('t1'), makeTrack('t2'), makeTrack('t3')];
    const { toggle, setPlaybackQueue, setPlayMode, lastCall } = setup('shuffle', queue, queue[0]);

    expect(toggle()).toBe('repeat-all');

    const restored = lastCall(setPlaybackQueue) as Track[];
    expect(restored.map(t => t.id)).toEqual(['t1', 't2', 't3']);
    expect(lastCall(setPlayMode)).toBe('repeat-all');
  });

  it('UPGRADE 8: current không có trong queue khi vào shuffle → fallbackHead được ensureQueueItemId (queueItemId luôn có)', () => {
    const queue = [makeTrack('t1'), makeTrack('t2')];
    const current = makeTrack('t9');
    const { toggle, setPlaybackQueue, lastCall } = setup('normal', queue, current);

    expect(toggle()).toBe('shuffle');

    const shuffled = lastCall(setPlaybackQueue) as Track[];
    expect(shuffled[0].id).toBe('t9');
    expect(shuffled[0].queueItemId).toBeTypeOf('string');
    expect(new Set(shuffled)).toHaveLength(3);
  });
});

describe('shuffleQueueWithCurrent', () => {
  it('bài hiện tại luôn ở vị trí 0 (giữ nguyên reference)', () => {
    const queue = [makeTrack('t1'), makeTrack('t2'), makeTrack('t3'), makeTrack('t4')];
    const result = shuffleQueueWithCurrent(queue, queue[1], queue[0]);
    expect(result[0]).toBe(queue[1]);
  });

  it('đủ phần tử, không mất/dúp khi current có trong queue', () => {
    const queue = [makeTrack('t1'), makeTrack('t2'), makeTrack('t3'), makeTrack('t4'), makeTrack('t5')];
    const result = shuffleQueueWithCurrent(queue, queue[3], queue[0]);
    expect(result).toHaveLength(5);
    expect(new Set(result)).toHaveLength(5);
    queue.forEach(t => expect(result).toContain(t));
  });

  it('deterministic khi Math.random mock giá trị cố định', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const queue = [makeTrack('t1'), makeTrack('t2'), makeTrack('t3')];
      const result = shuffleQueueWithCurrent(queue, queue[2], queue[0]);
      expect(result.map(t => t.id)).toEqual(['t3', 't2', 't1']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('queue rỗng → trả về []', () => {
    const result = shuffleQueueWithCurrent([], makeTrack('t1'), makeTrack('t9'));
    expect(result).toEqual([]);
  });

  it('current không có trong queue → head = fallbackHead (không phải shuffled[0]), không dúp, fallbackHead chỉ xuất hiện 1 lần', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const queue = [makeTrack('t1'), makeTrack('t2'), makeTrack('t3')];
      const current = makeTrack('t9');
      const fallbackHead = { ...current, queueItemId: 'q-fallback' };
      const result = shuffleQueueWithCurrent(queue, current, fallbackHead);
      expect(result[0]).toBe(fallbackHead);
      expect(result[0]).not.toBe(queue[0]);
      expect(result.map(t => t.id)).toEqual(['t9', 't2', 't3', 't1']);
      expect(new Set(result)).toHaveLength(4);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('updateQueueContext', () => {
  const setup = (playMode: PlayMode) => {
    const setPlaybackQueue = vi.fn();
    const setOriginalQueue = vi.fn();
    const setPlayMode = vi.fn();
    const handlePlayTrack = vi.fn();
    const { result } = renderHook(() =>
      usePlayerQueue(null, [], [], playMode, setPlaybackQueue, setOriginalQueue, setPlayMode, handlePlayTrack)
    );
    return { result, setPlaybackQueue, setOriginalQueue };
  };

  it('driveItems (My Drive): lọc folder + item thiếu trackInfo, map qua ensureQueueItemId, lưu kv bằng SESSION_CLEANUP_KEYS.queueKv (lock UPGRADE 1 + 7)', () => {
    const { result, setOriginalQueue, setPlaybackQueue } = setup('normal');
    const t1 = makeTrack('t1');
    const t2 = makeTrack('t2');
    const driveItems = [
      { isFolder: true, trackInfo: makeTrack('folder') },
      { trackInfo: t1 },
      { trackInfo: t2 },
      { isFolder: false },
    ];

    let target: Track | undefined;
    act(() => {
      target = result.current.updateQueueContext(t1, undefined, driveItems, 'My Drive');
    });

    const saved = setOriginalQueue.mock.calls[0]?.[0] as Track[];
    expect(saved).toHaveLength(2);
    expect(saved.map(t => t.id)).toEqual(['t1', 't2']);
    saved.forEach(t => expect(t.queueItemId).toBeTypeOf('string'));
    expect(vi.mocked(idbSet)).toHaveBeenCalledWith(SESSION_CLEANUP_KEYS.queueKv, saved);
    expect(setPlaybackQueue).toHaveBeenCalledWith(saved);
    expect(target?.id).toBe('t1');
  });

  it('không có contextQueue/driveItems → queue clear: idbSet(SESSION_CLEANUP_KEYS.queueKv, []) (lock UPGRADE 1)', () => {
    const { result, setPlaybackQueue } = setup('normal');

    act(() => {
      result.current.updateQueueContext(makeTrack('t5'), undefined, undefined, 'Settings');
    });

    expect(vi.mocked(idbSet)).toHaveBeenCalledWith(SESSION_CLEANUP_KEYS.queueKv, []);
    expect(setPlaybackQueue.mock.calls[0]?.[0] as Track[]).toHaveLength(1);
  });
});
