import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTracksToQueue,
  persistQueue,
  removeTracksByFolderFromQueue,
  removeTracksFromQueue,
} from "./queueOps";
import { usePlayerStore } from "./playerStore";
import type { PlayMode, Track } from "../types";
import { set as idbSet } from "../db/kv";
import { captureError } from "../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../utils/sessionCleanup";

vi.mock("../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const baseTrack: Track = {
  id: "t1",
  title: "Title",
  artist: "Artist",
  streamUrl: "https://stream.example/t1",
};

const makeTrack = (id: string, extra: Partial<Track> = {}): Track => ({
  ...baseTrack,
  id,
  ...extra,
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Seed {
  originalQueue?: Track[];
  playbackQueue?: Track[];
  currentTrack?: Track | null;
  playMode?: PlayMode;
}

function seed(partial: Seed): void {
  usePlayerStore.setState({
    originalQueue: partial.originalQueue ?? [],
    playbackQueue: partial.playbackQueue ?? [],
    currentTrack: partial.currentTrack ?? null,
    playMode: partial.playMode ?? "normal",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed({});
});

describe("appendTracksToQueue", () => {
  it("queue rỗng → cả 2 queue = đúng tracks, mỗi track có queueItemId UUID, persist queueKv, return count", () => {
    const added = appendTracksToQueue([makeTrack("t1"), makeTrack("t2")]);

    expect(added).toBe(2);
    const state = usePlayerStore.getState();
    expect(state.originalQueue.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(state.playbackQueue.map((t) => t.id)).toEqual(["t1", "t2"]);
    for (const track of state.originalQueue) {
      expect(track.queueItemId).toMatch(UUID_RE);
    }
    expect(vi.mocked(idbSet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(idbSet)).toHaveBeenCalledWith(
      SESSION_CLEANUP_KEYS.queueKv,
      state.originalQueue,
    );
  });

  it("đã có queue (normal) → thứ tự cũ giữ nguyên, bài mới nối đuôi CẢ 2 queue", () => {
    seed({
      originalQueue: [makeTrack("a")],
      playbackQueue: [makeTrack("a")],
    });

    const added = appendTracksToQueue([makeTrack("b")]);

    expect(added).toBe(1);
    const state = usePlayerStore.getState();
    expect(state.originalQueue.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.playbackQueue.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("playMode shuffle → nối đuôi playbackQueue hiện tại, KHÔNG reshuffle", () => {
    const b = makeTrack("b");
    seed({
      playMode: "shuffle",
      originalQueue: [makeTrack("a"), b, makeTrack("c")],
      playbackQueue: [b, makeTrack("c"), makeTrack("a")],
      currentTrack: b,
    });

    appendTracksToQueue([makeTrack("d"), makeTrack("e")]);

    const state = usePlayerStore.getState();
    expect(state.playbackQueue.map((t) => t.id)).toEqual([
      "b",
      "c",
      "a",
      "d",
      "e",
    ]);
    expect(state.originalQueue.map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("tracks rỗng → no-op hoàn toàn (không set store, không persist)", () => {
    const existing = makeTrack("a");
    seed({ originalQueue: [existing], playbackQueue: [existing] });

    expect(appendTracksToQueue([])).toBe(0);

    const state = usePlayerStore.getState();
    expect(state.originalQueue).toEqual([existing]);
    expect(state.playbackQueue).toEqual([existing]);
    expect(vi.mocked(idbSet)).not.toHaveBeenCalled();
  });

  it("track đã có queueItemId → giữ nguyên id đó (không tạo mới)", () => {
    appendTracksToQueue([makeTrack("t1", { queueItemId: "keep-me" })]);

    const state = usePlayerStore.getState();
    expect(state.originalQueue[0]?.queueItemId).toBe("keep-me");
    expect(state.playbackQueue[0]?.queueItemId).toBe("keep-me");
  });
});

describe("removeTracksFromQueue", () => {
  it("xoá đúng queueItemId ở CẢ 2 queue, persist queue mới, return số xoá khỏi originalQueue", () => {
    const a = makeTrack("a", { queueItemId: "q-a" });
    const b = makeTrack("b", { queueItemId: "q-b" });
    const c = makeTrack("c", { queueItemId: "q-c" });
    seed({ originalQueue: [a, b, c], playbackQueue: [c, a, b] });

    const removed = removeTracksFromQueue(["q-b"]);

    expect(removed).toBe(1);
    const state = usePlayerStore.getState();
    expect(state.originalQueue.map((t) => t.id)).toEqual(["a", "c"]);
    expect(state.playbackQueue.map((t) => t.id)).toEqual(["c", "a"]);
    expect(vi.mocked(idbSet)).toHaveBeenCalledWith(
      SESSION_CLEANUP_KEYS.queueKv,
      state.originalQueue,
    );
  });

  it("itemIds chứa queueItemId của bài đang phát → current được giữ, bài khác vẫn bị xoá", () => {
    const a = makeTrack("a", { queueItemId: "q-a" });
    const b = makeTrack("b", { queueItemId: "q-b" });
    const c = makeTrack("c", { queueItemId: "q-c" });
    seed({
      originalQueue: [a, b, c],
      playbackQueue: [a, b, c],
      currentTrack: b,
    });

    const removed = removeTracksFromQueue(["q-b", "q-c"]);

    expect(removed).toBe(1);
    const state = usePlayerStore.getState();
    expect(state.originalQueue.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.playbackQueue.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("chỉ có current khớp itemIds → không đổi gì, return 0, không persist", () => {
    const b = makeTrack("b", { queueItemId: "q-b" });
    seed({
      originalQueue: [makeTrack("a", { queueItemId: "q-a" }), b],
      playbackQueue: [b],
      currentTrack: b,
    });
    const before = usePlayerStore.getState().originalQueue;

    expect(removeTracksFromQueue(["q-b"])).toBe(0);

    expect(usePlayerStore.getState().originalQueue).toBe(before);
    expect(vi.mocked(idbSet)).not.toHaveBeenCalled();
  });

  it("itemIds không match gì → return 0, không persist, không set store", () => {
    const a = makeTrack("a", { queueItemId: "q-a" });
    seed({ originalQueue: [a], playbackQueue: [a] });
    const before = usePlayerStore.getState().originalQueue;

    expect(removeTracksFromQueue(["nope"])).toBe(0);

    expect(usePlayerStore.getState().originalQueue).toBe(before);
    expect(vi.mocked(idbSet)).not.toHaveBeenCalled();
  });

  it("itemIds rỗng → return 0, no-op", () => {
    seed({ originalQueue: [makeTrack("a", { queueItemId: "q-a" })] });

    expect(removeTracksFromQueue([])).toBe(0);

    expect(vi.mocked(idbSet)).not.toHaveBeenCalled();
  });

  it("legacy entry (không có queueItemId) → match được theo track.id", () => {
    const legacy = makeTrack("legacy-1");
    const withId = makeTrack("b", { queueItemId: "q-b" });
    seed({ originalQueue: [legacy, withId], playbackQueue: [legacy, withId] });

    const removed = removeTracksFromQueue(["legacy-1"]);

    expect(removed).toBe(1);
    const state = usePlayerStore.getState();
    expect(state.originalQueue.map((t) => t.id)).toEqual(["b"]);
    expect(state.playbackQueue.map((t) => t.id)).toEqual(["b"]);
  });
});

describe("removeTracksByFolderFromQueue", () => {
  it("xoá hết track cùng parentId trừ bài đang phát, return số xoá", () => {
    const f1 = makeTrack("f1", { parentId: "folder-1", queueItemId: "q-f1" });
    const cur = makeTrack("cur", {
      parentId: "folder-1",
      queueItemId: "q-cur",
    });
    const f2 = makeTrack("f2", { parentId: "folder-1", queueItemId: "q-f2" });
    const other = makeTrack("o", { parentId: "folder-2", queueItemId: "q-o" });
    seed({
      originalQueue: [f1, cur, f2, other],
      playbackQueue: [f1, cur, f2, other],
      currentTrack: cur,
    });

    expect(removeTracksByFolderFromQueue("folder-1")).toBe(2);

    const state = usePlayerStore.getState();
    expect(state.originalQueue.map((t) => t.id)).toEqual(["cur", "o"]);
    expect(state.playbackQueue.map((t) => t.id)).toEqual(["cur", "o"]);
  });

  it("parentId rỗng → return 0, no-op", () => {
    seed({ originalQueue: [makeTrack("f1", { parentId: "folder-1" })] });

    expect(removeTracksByFolderFromQueue("")).toBe(0);

    expect(vi.mocked(idbSet)).not.toHaveBeenCalled();
  });

  it("parentId undefined (runtime guard) → return 0, no-op", () => {
    seed({ originalQueue: [makeTrack("f1", { parentId: "folder-1" })] });
    // Simulates an untyped caller — the guard must survive runtime undefined.
    const bogusParentId = undefined as unknown as string;

    expect(removeTracksByFolderFromQueue(bogusParentId)).toBe(0);

    expect(vi.mocked(idbSet)).not.toHaveBeenCalled();
  });
});

describe("persistQueue", () => {
  it("idbSet reject → captureError level warn source queueOps, KHÔNG throw", async () => {
    vi.mocked(idbSet).mockRejectedValueOnce(new Error("idb exploded"));

    expect(() => {
      persistQueue([]);
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(vi.mocked(captureError)).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "queueOps",
          message: expect.stringContaining(
            "queue-save-fail",
          ) as unknown as string,
        }),
      );
    });
  });

  it("persist queue rỗng [] qua đúng queueKv", () => {
    persistQueue([]);

    expect(vi.mocked(idbSet)).toHaveBeenCalledWith(
      SESSION_CLEANUP_KEYS.queueKv,
      [],
    );
  });
});
