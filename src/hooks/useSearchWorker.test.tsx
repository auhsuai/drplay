// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { db, type DriveFile } from "../db/db";
import { captureError } from "../utils/errorLog";
import { resetSearchWorkerState } from "../search/search.worker";
import type {
  SearchWorkerRequest,
  SearchWorkerResponse,
} from "../search/search.worker";
import type { SearchHit } from "../search/searchEngine";
import {
  createSearchExecutor,
  setSearchExecutorFactoryForTests,
  useSearchWorker,
  type SearchExecutor,
} from "./useSearchWorker";

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

// jsdom has no `Worker`, so the hook always takes the inline fallback path in
// these tests (real db + fake-indexeddb). The factory seam swaps in a fake
// executor only where deterministic response ordering is required (debounce /
// race / unmount / error tests).
// Fake ONLY timers (never setImmediate) so Dexie chains progress on the real
// event loop while the debounce/invalidate timers stay controllable — the
// same pattern as uploadManager.test.ts.
const FAKE_TIMERS_TOFAKE = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
] as const;

const ROOT_ID = "root";

function makeFile(id: string, name: string): DriveFile {
  return {
    id,
    name,
    mimeType: "audio/mpeg",
    parentId: ROOT_ID,
    trashed: false,
    isFolder: false,
    modifiedTime: "2024-01-01T00:00:00.000Z",
    size: 1000,
    userEmail: "default", // compound PK part (schema v10)
  };
}

function makeHit(id: string, name: string, score: number): SearchHit {
  return {
    id,
    score,
    name,
    isFolder: false,
    title: name.replace(/\.[^.]+$/, ""),
    artist: null,
    parentId: ROOT_ID,
    mimeType: "audio/mpeg",
  };
}

// Deterministic executor stand-in: records posted messages and exposes the
// onResponse listener for manual, out-of-order response dispatch.
interface FakeExecutor extends SearchExecutor {
  posted: SearchWorkerRequest[];
  responders: Array<(r: SearchWorkerResponse) => void>;
  terminateSpy: ReturnType<typeof vi.fn>;
}

function createFakeExecutor(): FakeExecutor {
  const posted: SearchWorkerRequest[] = [];
  const responders: Array<(r: SearchWorkerResponse) => void> = [];
  const terminateSpy = vi.fn();
  return {
    posted,
    responders,
    terminateSpy,
    post: (msg) => {
      posted.push(msg);
    },
    onResponse: (listener) => {
      responders.push(listener);
    },
    terminate: terminateSpy,
  };
}

function respond(fake: FakeExecutor, response: SearchWorkerResponse): void {
  const listener = fake.responders[0];
  if (listener === undefined)
    throw new Error("no onResponse listener registered");
  listener(response);
}

// jsdom has no Worker: install a constructor stand-in so the REAL
// createWorkerExecutor path (not the inline fallback) can be driven directly.
interface FakeWorkerInstance {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function installFakeWorker(): {
  instances: FakeWorkerInstance[];
  WorkerCtor: ReturnType<typeof vi.fn>;
} {
  const instances: FakeWorkerInstance[] = [];
  const WorkerCtor = vi.fn(function () {
    const instance: FakeWorkerInstance = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    instances.push(instance);
    return instance;
  });
  vi.stubGlobal("Worker", WorkerCtor);
  return { instances, WorkerCtor };
}

// Advances faked timers and then flushes leftover microtasks (Dexie chains
// that settle on real setImmediate) so inline-path state updates land inside
// act.
async function flush(ms = 250): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useSearchWorker", () => {
  beforeEach(async () => {
    await db.files.clear();
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    setSearchExecutorFactoryForTests(createSearchExecutor);
    resetSearchWorkerState();
    vi.mocked(captureError).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("10. debounces: rapid query changes collapse to the last one only", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10), {
      initialProps: { q: "a" },
    });
    act(() => {
      view.rerender({ q: "ab" });
    });
    await flush(100); // 'ab' debounce (150ms) not yet elapsed
    act(() => {
      view.rerender({ q: "abc" });
    });
    await flush(200); // 'abc' debounce elapses
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]).toMatchObject({
      type: "query",
      query: "abc",
      requestId: 1,
      // Owner rides on every query frame so the worker can scope its index.
      userEmail: "default",
    });
    view.unmount();
  });

  it("11. empty query clears hits immediately and never touches the executor", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10), {
      initialProps: { q: "" },
    });
    expect(view.result.current.hits).toEqual([]);
    await flush(200);
    expect(fake.posted).toHaveLength(0);

    act(() => {
      view.rerender({ q: "abc" });
    });
    await flush(200);
    expect(fake.posted).toHaveLength(1);

    act(() => {
      view.rerender({ q: "" });
    });
    expect(view.result.current.hits).toEqual([]);
    await flush(200);
    expect(fake.posted).toHaveLength(1); // no second query sent
    view.unmount();
  });

  it("12. diacritics end-to-end through the real inline path", async () => {
    await db.files.bulkPut([makeFile("f1", "Đổi thay.mp3")]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10), {
      initialProps: { q: "doi" },
    });
    await flush(250); // debounce + rebuild + query
    expect(view.result.current.hits.map((h) => h.id)).toContain("f1");
    view.unmount();
  });

  it("13. invalidation: a new db.files write marks the index stale and the next query rebuilds", async () => {
    await db.files.bulkPut([makeFile("f1", "Anh dong vien - Yeu em.mp3")]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10), {
      initialProps: { q: "anh" },
    });
    await flush(250);
    expect(view.result.current.hits.map((h) => h.id)).toContain("f1");

    // Write outside the hook triggers the main-thread Dexie hook.
    await db.files.put(makeFile("f2", "Anh yeu em.mp3"));
    await flush(320); // invalidation throttle (300ms) elapses -> stale

    act(() => {
      view.rerender({ q: "anh yeu" });
    });
    await flush(250); // debounce + rebuild with the fresh index
    expect(view.result.current.hits.map((h) => h.id)).toContain("f2");
    view.unmount();
  });

  it("14. race guard: an older response arriving after a newer one is dropped", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10), {
      initialProps: { q: "old" },
    });
    await flush(200); // requestId 1 sent
    act(() => {
      view.rerender({ q: "new" });
    });
    await flush(200); // requestId 2 sent
    expect(fake.posted).toHaveLength(2);

    const hitNew = makeHit("n", "new.mp3", 2);
    const hitOld = makeHit("o", "old.mp3", 1);
    act(() => {
      respond(fake, { type: "results", requestId: 2, hits: [hitNew] });
    });
    expect(view.result.current.hits).toEqual([hitNew]);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitOld] });
    });
    expect(view.result.current.hits).toEqual([hitNew]); // stale response ignored
    view.unmount();
  });

  it("15. unmount terminates the executor and clears pending timers", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10), {
      initialProps: { q: "x" },
    });
    view.unmount();
    expect(fake.terminateSpy).toHaveBeenCalledTimes(1);
    await flush(1000); // a leaked debounce timer would have posted by now
    expect(fake.posted).toHaveLength(0);
  });

  it("16. error response logs via captureError and keeps last-good hits", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10), {
      initialProps: { q: "x" },
    });
    await flush(200);
    const hitA = makeHit("a", "Anh.mp3", 1);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitA] });
    });
    expect(view.result.current.hits).toEqual([hitA]);

    act(() => {
      respond(fake, {
        type: "error",
        requestId: 1,
        message: "rebuild-failed: index boom",
      });
    });
    expect(view.result.current.hits).toEqual([hitA]); // last-good kept
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "useSearchWorker" }),
    );
    view.unmount();
  });

  describe("createWorkerExecutor resilience (B15-4)", () => {
    it("17. surfaces a synthetic error response and logs at error level when the worker crashes", () => {
      const { instances } = installFakeWorker();
      const executor = createSearchExecutor();
      const responses: SearchWorkerResponse[] = [];
      executor.onResponse((r) => responses.push(r));

      instances[0]?.onerror?.({ message: "boom" } as ErrorEvent);

      expect(responses).toEqual([{ type: "error", message: "worker-crashed" }]);
      expect(vi.mocked(captureError)).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          source: "searchWorker",
          message: expect.stringContaining(
            "worker-error: boom",
          ) as unknown as string,
        }),
      );
      executor.terminate();
    });

    it("18. post() after a crash recreates the worker (rebound handlers) and routes the message to the fresh instance", () => {
      const { instances, WorkerCtor } = installFakeWorker();
      const executor = createSearchExecutor();

      instances[0]?.onerror?.({ message: "boom" } as ErrorEvent);
      executor.post({ type: "init" });

      expect(WorkerCtor).toHaveBeenCalledTimes(2);
      expect(instances).toHaveLength(2);
      expect(instances[1]?.postMessage).toHaveBeenCalledWith({ type: "init" });

      // The fresh instance must be rebound: its responses still reach the
      // listener registered BEFORE the crash.
      const responses: SearchWorkerResponse[] = [];
      executor.onResponse((r) => responses.push(r));
      instances[1]?.onmessage?.({ data: { type: "ready" } } as MessageEvent);
      expect(responses).toEqual([{ type: "ready" }]);

      executor.terminate();
    });

    it("19. falls back to the inline executor when `new Worker` throws synchronously", async () => {
      const WorkerCtor = vi.fn(() => {
        throw new DOMException("bad url", "SyntaxError");
      });
      vi.stubGlobal("Worker", WorkerCtor);

      const executor = createSearchExecutor();
      const responses: SearchWorkerResponse[] = [];
      executor.onResponse((r) => responses.push(r));
      executor.post({
        type: "query",
        requestId: 1,
        query: "anything",
        limit: 10,
        userEmail: "default",
      });

      await flush(250);
      expect(responses).toEqual([{ type: "results", requestId: 1, hits: [] }]);
      expect(WorkerCtor).toHaveBeenCalledTimes(1);
      executor.terminate();
    });

    it("20. a failing recreate is logged and the post is dropped instead of crash-looping", () => {
      const { instances, WorkerCtor } = installFakeWorker();
      const executor = createSearchExecutor();
      WorkerCtor.mockImplementation(() => {
        throw new DOMException("bad url", "SyntaxError");
      });
      instances[0]?.onerror?.({ message: "boom" } as ErrorEvent);

      expect(() => {
        executor.post({ type: "init" });
      }).not.toThrow();
      expect(instances[0]?.postMessage).not.toHaveBeenCalled();
      expect(vi.mocked(captureError)).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          source: "searchWorker",
          message: expect.stringContaining(
            "worker-create-failed",
          ) as unknown as string,
        }),
      );
      expect(WorkerCtor).toHaveBeenCalledTimes(2);
      executor.terminate();
    });
  });

  it("21. inline path indexes only the active account's rows (cross-account isolation)", async () => {
    await db.files.bulkPut([
      makeFile("mine", "My Song.mp3"),
      { ...makeFile("theirs", "Other Song.mp3"), userEmail: "other@x" },
    ]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10), {
      initialProps: { q: "song" },
    });
    await flush(250);
    expect(view.result.current.hits.map((h) => h.id)).toEqual(["mine"]);
    view.unmount();
  });
});
