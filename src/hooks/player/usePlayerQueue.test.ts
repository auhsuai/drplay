// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  ensureQueueItemId,
  sameTrack,
  shuffleQueueWithCurrent,
  usePlayerQueue,
} from "./usePlayerQueue";
import type { PlayMode, Track } from "../../types";
import { set as idbSet } from "../../db/kv";
import { SESSION_CLEANUP_KEYS } from "../../utils/sessionCleanup";
import { usePlayerStore } from "../../store/playerStore";

vi.mock("../../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const baseTrack: Track = {
  id: "t1",
  title: "Title",
  artist: "Artist",
  streamUrl: "https://stream.example/t1",
};

const makeTrack = (id: string): Track => ({ ...baseTrack, id });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("ensureQueueItemId", () => {
  it("trả về track cũ (không clone, giữ nguyên queueItemId) khi đã có queueItemId", () => {
    const track: Track = { ...baseTrack, queueItemId: "existing-id" };
    const result = ensureQueueItemId(track);
    expect(result).toBe(track);
    expect(result.queueItemId).toBe("existing-id");
  });

  it("clone + gán queueItemId UUID mới khi chưa có queueItemId", () => {
    const result = ensureQueueItemId(baseTrack);
    expect(result).not.toBe(baseTrack);
    expect(result.queueItemId).toBeTypeOf("string");
    expect(result.queueItemId).toMatch(UUID_RE);
    expect(result.id).toBe("t1");
    expect(baseTrack.queueItemId).toBeUndefined();
  });
});

describe("sameTrack", () => {
  it("cả 2 có queueItemId → true khi queueItemId khớp dù id khác", () => {
    const a: Track = { ...baseTrack, id: "t1", queueItemId: "q1" };
    const b: Track = { ...baseTrack, id: "t2", queueItemId: "q1" };
    expect(sameTrack(a, b)).toBe(true);
  });

  it("cả 2 có queueItemId → false khi queueItemId khác dù id giống", () => {
    const a: Track = { ...baseTrack, id: "t1", queueItemId: "q1" };
    const b: Track = { ...baseTrack, id: "t1", queueItemId: "q2" };
    expect(sameTrack(a, b)).toBe(false);
  });

  it("1 bên thiếu queueItemId → so theo id", () => {
    const a: Track = { ...baseTrack, id: "t1", queueItemId: "q1" };
    const b: Track = { ...baseTrack, id: "t1" };
    expect(sameTrack(a, b)).toBe(true);
    expect(sameTrack(b, a)).toBe(true);
    const c: Track = { ...baseTrack, id: "t2" };
    expect(sameTrack(a, c)).toBe(false);
  });

  it("cả 2 thiếu queueItemId → so theo id", () => {
    const a: Track = { ...baseTrack, id: "t1" };
    const b: Track = { ...baseTrack, id: "t1" };
    const c: Track = { ...baseTrack, id: "t2" };
    expect(sameTrack(a, b)).toBe(true);
    expect(sameTrack(a, c)).toBe(false);
  });
});

describe("handleTogglePlayMode", () => {
  const setup = (
    playMode: PlayMode,
    originalQueue: Track[],
    currentTrack: Track | null,
  ) => {
    const setPlaybackQueue = vi.fn();
    const setOriginalQueue = vi.fn();
    const setPlayMode = vi.fn();
    const handlePlayTrack = vi.fn();

    const { result, rerender } = renderHook(
      ({ pm, oq, ct }: { pm: PlayMode; oq: Track[]; ct: Track | null }) =>
        usePlayerQueue(
          ct,
          [],
          oq,
          pm,
          setPlaybackQueue,
          setOriginalQueue,
          setPlayMode,
          handlePlayTrack,
        ),
      { initialProps: { pm: playMode, oq: originalQueue, ct: currentTrack } },
    );

    const toggle = (): PlayMode => {
      act(() => {
        result.current.handleTogglePlayMode();
      });
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

  it("toggle 4 lần → cycle đủ 4 mode đúng thứ tự normal→shuffle→repeat-all→repeat-one→normal", () => {
    const { toggle } = setup("normal", [], null);
    const seen: PlayMode[] = [];
    for (let i = 0; i < 4; i++) seen.push(toggle());
    expect(seen).toEqual(["shuffle", "repeat-all", "repeat-one", "normal"]);
  });

  it("vào shuffle với queue > 0 → queue bị shuffle: đủ phần tử, track hiện tại ở đầu, thứ tự đổi", () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const third = queue[2];
    if (third === undefined) throw new Error("expected track at index 2");
    const { toggle, setPlaybackQueue, setPlayMode, lastCall } = setup(
      "normal",
      queue,
      third,
    );

    expect(toggle()).toBe("shuffle");

    const shuffled = lastCall(setPlaybackQueue) as Track[];
    expect(shuffled).toHaveLength(3);
    expect(new Set(shuffled.map((t) => t.id))).toEqual(
      new Set(["t1", "t2", "t3"]),
    );
    expect(shuffled[0]?.id).toBe("t3");
    expect(shuffled.map((t) => t.id)).not.toEqual(["t1", "t2", "t3"]);
    expect(lastCall(setPlayMode)).toBe("shuffle");
  });

  it("rời shuffle → queue restore về thứ tự gốc", () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const first = queue[0];
    if (first === undefined) throw new Error("expected track at index 0");
    const { toggle, setPlaybackQueue, setPlayMode, lastCall } = setup(
      "shuffle",
      queue,
      first,
    );

    expect(toggle()).toBe("repeat-all");

    const restored = lastCall(setPlaybackQueue) as Track[];
    expect(restored.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(lastCall(setPlayMode)).toBe("repeat-all");
  });

  it("UPGRADE 8: current không có trong queue khi vào shuffle → fallbackHead được ensureQueueItemId (queueItemId luôn có)", () => {
    const queue = [makeTrack("t1"), makeTrack("t2")];
    const current = makeTrack("t9");
    const { toggle, setPlaybackQueue, lastCall } = setup(
      "normal",
      queue,
      current,
    );

    expect(toggle()).toBe("shuffle");

    const shuffled = lastCall(setPlaybackQueue) as Track[];
    expect(shuffled[0]?.id).toBe("t9");
    expect(shuffled[0]?.queueItemId).toBeTypeOf("string");
    expect(new Set(shuffled)).toHaveLength(3);
  });
});

describe("shuffleQueueWithCurrent", () => {
  it("bài hiện tại luôn ở vị trí 0 (giữ nguyên reference)", () => {
    const queue = [
      makeTrack("t1"),
      makeTrack("t2"),
      makeTrack("t3"),
      makeTrack("t4"),
    ];
    const second = queue[1];
    const first = queue[0];
    if (second === undefined || first === undefined)
      throw new Error("expected tracks at indices 0,1");
    const result = shuffleQueueWithCurrent(queue, second, first);
    expect(result[0]).toBe(queue[1]);
  });

  it("đủ phần tử, không mất/dúp khi current có trong queue", () => {
    const queue = [
      makeTrack("t1"),
      makeTrack("t2"),
      makeTrack("t3"),
      makeTrack("t4"),
      makeTrack("t5"),
    ];
    const fourth = queue[3];
    const first = queue[0];
    if (fourth === undefined || first === undefined)
      throw new Error("expected tracks at indices 0,3");
    const result = shuffleQueueWithCurrent(queue, fourth, first);
    expect(result).toHaveLength(5);
    expect(new Set(result)).toHaveLength(5);
    queue.forEach((t) => {
      expect(result).toContain(t);
    });
  });

  it("deterministic khi Math.random mock giá trị cố định", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
      const third = queue[2];
      const first = queue[0];
      if (third === undefined || first === undefined)
        throw new Error("expected tracks at indices 0,2");
      const result = shuffleQueueWithCurrent(queue, third, first);
      expect(result.map((t) => t.id)).toEqual(["t3", "t2", "t1"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("queue rỗng → trả về []", () => {
    const result = shuffleQueueWithCurrent(
      [],
      makeTrack("t1"),
      makeTrack("t9"),
    );
    expect(result).toEqual([]);
  });

  it("current không có trong queue → head = fallbackHead (không phải shuffled[0]), không dúp, fallbackHead chỉ xuất hiện 1 lần", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
      const current = makeTrack("t9");
      const fallbackHead = { ...current, queueItemId: "q-fallback" };
      const result = shuffleQueueWithCurrent(queue, current, fallbackHead);
      expect(result[0]).toBe(fallbackHead);
      expect(result[0]).not.toBe(queue[0]);
      expect(result.map((t) => t.id)).toEqual(["t9", "t2", "t3", "t1"]);
      expect(new Set(result)).toHaveLength(4);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("updateQueueContext", () => {
  const setup = (playMode: PlayMode) => {
    const setPlaybackQueue = vi.fn();
    const setOriginalQueue = vi.fn();
    const setPlayMode = vi.fn();
    const handlePlayTrack = vi.fn();
    const { result } = renderHook(() =>
      usePlayerQueue(
        null,
        [],
        [],
        playMode,
        setPlaybackQueue,
        setOriginalQueue,
        setPlayMode,
        handlePlayTrack,
      ),
    );
    return { result, setPlaybackQueue, setOriginalQueue };
  };

  it("driveItems (My Drive): lọc folder + item thiếu trackInfo, map qua ensureQueueItemId, lưu kv bằng SESSION_CLEANUP_KEYS.queueKv (lock UPGRADE 1 + 7)", () => {
    const { result, setOriginalQueue, setPlaybackQueue } = setup("normal");
    const t1 = makeTrack("t1");
    const t2 = makeTrack("t2");
    const driveItems = [
      { isFolder: true, trackInfo: makeTrack("folder") },
      { trackInfo: t1 },
      { trackInfo: t2 },
      { isFolder: false },
    ];

    let target: Track | undefined;
    act(() => {
      target = result.current.updateQueueContext(
        t1,
        undefined,
        driveItems,
        "My Drive",
      );
    });

    const saved = setOriginalQueue.mock.calls[0]?.[0] as Track[];
    expect(saved).toHaveLength(2);
    expect(saved.map((t) => t.id)).toEqual(["t1", "t2"]);
    saved.forEach((t) => {
      expect(t.queueItemId).toBeTypeOf("string");
    });
    expect(vi.mocked(idbSet)).toHaveBeenCalledWith(
      SESSION_CLEANUP_KEYS.queueKv,
      saved,
    );
    expect(setPlaybackQueue).toHaveBeenCalledWith(saved);
    expect(target?.id).toBe("t1");
  });

  it("không có contextQueue/driveItems → queue clear: idbSet(SESSION_CLEANUP_KEYS.queueKv, []) (lock UPGRADE 1)", () => {
    const { result, setPlaybackQueue } = setup("normal");

    act(() => {
      result.current.updateQueueContext(
        makeTrack("t5"),
        undefined,
        undefined,
        "Settings",
      );
    });

    expect(vi.mocked(idbSet)).toHaveBeenCalledWith(
      SESSION_CLEANUP_KEYS.queueKv,
      [],
    );
    expect(setPlaybackQueue.mock.calls[0]?.[0] as Track[]).toHaveLength(1);
  });
});

describe("handleNextTrack broken-track guard (Task D — repeat-all loop)", () => {
  const setup = (
    currentTrack: Track | null,
    playbackQueue: Track[],
    playMode: PlayMode,
  ) => {
    const setPlaybackQueue = vi.fn();
    const setOriginalQueue = vi.fn();
    const setPlayMode = vi.fn();
    const handlePlayTrack = vi.fn();

    const { result } = renderHook(() =>
      usePlayerQueue(
        currentTrack,
        playbackQueue,
        playbackQueue,
        playMode,
        setPlaybackQueue,
        setOriginalQueue,
        setPlayMode,
        handlePlayTrack,
      ),
    );
    return { result, handlePlayTrack };
  };

  beforeEach(() => {
    usePlayerStore.setState({ brokenTrackIds: [], isPlaying: false });
  });

  it("Task D regression: repeat-all + TOÀN BỘ queue hỏng → dừng, KHÔNG gọi handlePlayTrack dù gọi lặp lại nhiều vòng (hết loop vô hạn)", () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const current = queue[2];
    if (current === undefined) throw new Error("expected track at index 2");
    usePlayerStore.setState({ brokenTrackIds: ["t1", "t2", "t3"] });
    const { result, handlePlayTrack } = setup(current, queue, "repeat-all");

    // Mô phỏng các vòng ended → handleNextTrack liên tiếp (trước fix: mỗi
    // vòng phát lại t1 → error → ended → vòng mới = loop vô hạn).
    for (let i = 0; i < 5; i++) {
      act(() => {
        result.current.handleNextTrack();
      });
    }

    expect(handlePlayTrack).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("Task D: toàn bộ queue hỏng + current ở giữa queue → dừng, không phát tiếp", () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const current = queue[1];
    if (current === undefined) throw new Error("expected track at index 1");
    usePlayerStore.setState({ brokenTrackIds: ["t1", "t2", "t3"] });
    const { result, handlePlayTrack } = setup(current, queue, "repeat-all");

    act(() => {
      result.current.handleNextTrack();
    });

    expect(handlePlayTrack).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("Task D: 1 bài hỏng giữa queue → auto-skip sang bài không hỏng tiếp theo (isNavigation=true)", () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const current = queue[0];
    if (current === undefined) throw new Error("expected track at index 0");
    usePlayerStore.setState({ brokenTrackIds: ["t2"] });
    const { result, handlePlayTrack } = setup(current, queue, "repeat-all");

    act(() => {
      result.current.handleNextTrack();
    });

    expect(handlePlayTrack).toHaveBeenCalledTimes(1);
    expect(handlePlayTrack.mock.calls[0]?.[0]).toMatchObject({ id: "t3" });
    expect(handlePlayTrack.mock.calls[0]?.[2]).toBe(true);
  });

  it("Task D: bài tiếp theo không hỏng → phát bình thường (parity, không skip)", () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const current = queue[0];
    if (current === undefined) throw new Error("expected track at index 0");
    usePlayerStore.setState({ brokenTrackIds: [] });
    const { result, handlePlayTrack } = setup(current, queue, "repeat-all");

    act(() => {
      result.current.handleNextTrack();
    });

    expect(handlePlayTrack).toHaveBeenCalledTimes(1);
    expect(handlePlayTrack.mock.calls[0]?.[0]).toMatchObject({ id: "t2" });
  });

  it("Task D: repeat-all cuối queue quay đầu, bài đầu không hỏng → phát bài đầu (parity)", () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const current = queue[2];
    if (current === undefined) throw new Error("expected track at index 2");
    usePlayerStore.setState({ brokenTrackIds: [] });
    const { result, handlePlayTrack } = setup(current, queue, "repeat-all");

    act(() => {
      result.current.handleNextTrack();
    });

    expect(handlePlayTrack).toHaveBeenCalledTimes(1);
    expect(handlePlayTrack.mock.calls[0]?.[0]).toMatchObject({ id: "t1" });
  });

  it("Task D: repeat-all cuối queue, bài đầu hỏng nhưng bài 2 không → quay đầu skip bài hỏng", () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const current = queue[2];
    if (current === undefined) throw new Error("expected track at index 2");
    usePlayerStore.setState({ brokenTrackIds: ["t1"] });
    const { result, handlePlayTrack } = setup(current, queue, "repeat-all");

    act(() => {
      result.current.handleNextTrack();
    });

    expect(handlePlayTrack).toHaveBeenCalledTimes(1);
    expect(handlePlayTrack.mock.calls[0]?.[0]).toMatchObject({ id: "t2" });
  });

  it("Task D: normal mode cuối queue → không wrap, không phát thêm (parity)", () => {
    const queue = [makeTrack("t1"), makeTrack("t2")];
    const current = queue[1];
    if (current === undefined) throw new Error("expected track at index 1");
    usePlayerStore.setState({ brokenTrackIds: [] });
    const { result, handlePlayTrack } = setup(current, queue, "normal");

    act(() => {
      result.current.handleNextTrack();
    });

    expect(handlePlayTrack).not.toHaveBeenCalled();
  });

  it("Task D: repeat-one + bài duy nhất hỏng → không lặp vô hạn trên chính nó (dừng)", () => {
    const queue = [makeTrack("t1")];
    const current = queue[0];
    if (current === undefined) throw new Error("expected track at index 0");
    usePlayerStore.setState({ brokenTrackIds: ["t1"] });
    const { result, handlePlayTrack } = setup(current, queue, "repeat-one");

    for (let i = 0; i < 3; i++) {
      act(() => {
        result.current.handleNextTrack();
      });
    }

    expect(handlePlayTrack).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("Task D: ended tự nhiên (không có mark) + repeat-all 1 bài → lặp lại bình thường (parity)", () => {
    const queue = [makeTrack("t1")];
    const current = queue[0];
    if (current === undefined) throw new Error("expected track at index 0");
    usePlayerStore.setState({ brokenTrackIds: [] });
    const { result, handlePlayTrack } = setup(current, queue, "repeat-all");

    act(() => {
      result.current.handleNextTrack();
    });

    expect(handlePlayTrack).toHaveBeenCalledTimes(1);
    expect(handlePlayTrack.mock.calls[0]?.[0]).toMatchObject({ id: "t1" });
  });

  it("Task D: user bấm play lại bài từng hỏng (updateQueueContext) → xóa khỏi broken set (cơ hội mới)", () => {
    usePlayerStore.setState({ brokenTrackIds: ["t1", "t2"] });
    const setPlaybackQueue = vi.fn();
    const setOriginalQueue = vi.fn();
    const setPlayMode = vi.fn();
    const handlePlayTrack = vi.fn();
    const { result } = renderHook(() =>
      usePlayerQueue(
        null,
        [],
        [],
        "normal",
        setPlaybackQueue,
        setOriginalQueue,
        setPlayMode,
        handlePlayTrack,
      ),
    );

    act(() => {
      result.current.updateQueueContext(makeTrack("t1"), [
        makeTrack("t1"),
        makeTrack("t2"),
      ]);
    });

    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("t1");
    expect(usePlayerStore.getState().brokenTrackIds).toContain("t2");
  });
});
