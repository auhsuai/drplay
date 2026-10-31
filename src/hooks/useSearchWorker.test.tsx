// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { db, type DriveFile } from "../db/db";
import { useAuthStore } from "../store/authStore";
import { captureError } from "../utils/errorLog";
import { SYNC_EVENT_NAMES } from "../utils/proSyncManager";
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

// Every query frame needs a scope now (fail-closed wire, FIX 1/B2); module
// level so its identity never changes between renders of the same test.
const DEFAULT_CTX = {
  mode: "global" as const,
  rootIds: [ROOT_ID],
  sortField: "relevance" as const,
  sortDir: "desc" as const,
};

function makeFile(
  id: string,
  name: string,
  opts: { isFolder?: boolean; mimeType?: string; parentId?: string } = {},
): DriveFile {
  return {
    id,
    name,
    mimeType: opts.mimeType ?? "audio/mpeg",
    parentId: opts.parentId ?? ROOT_ID,
    trashed: false,
    isFolder: opts.isFolder ?? false,
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
    useAuthStore.setState({ userProfile: null });
    vi.mocked(captureError).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("10. debounces: rapid query changes collapse to the last one only", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
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
    // The requestId is bumped the moment an identity changes (B1.4), so the
    // surviving 'abc' frame carries the 3rd id; the ONE-post assertion above
    // is what proves the debounce collapsed 'a'/'ab'/'abc'.
    expect(fake.posted[0]).toMatchObject({
      type: "query",
      query: "abc",
      requestId: 3,
      // Owner rides on every query frame so the worker can scope its index.
      userEmail: "default",
    });
    view.unmount();
  });

  it("11. empty query clears hits immediately and never touches the executor", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
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
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "doi" },
    });
    await flush(250); // debounce + rebuild + query
    expect(view.result.current.hits.map((h) => h.id)).toContain("f1");
    view.unmount();
  });

  it("13. invalidation: a new db.files write marks the index stale and the next query rebuilds", async () => {
    await db.files.bulkPut([makeFile("f1", "Anh dong vien - Yeu em.mp3")]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
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
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
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
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "x" },
    });
    view.unmount();
    expect(fake.terminateSpy).toHaveBeenCalledTimes(1);
    await flush(1000); // a leaked debounce timer would have posted by now
    expect(fake.posted).toHaveLength(0);
  });

  it("16. error response for the current request clears the hits and logs", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
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
    // A failed current request exposes NO hits: the previous ones do not prove
    // anything about the query that just failed.
    expect(view.result.current.hits).toEqual([]);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "useSearchWorker" }),
    );
    view.unmount();
  });

  it("16b. a STALE error response (older requestId) is not logged; only the latest one is", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "old" },
    });
    await flush(200); // requestId 1 in flight
    act(() => {
      view.rerender({ q: "new" });
    });
    await flush(200); // requestId 2 is the latest

    act(() => {
      respond(fake, {
        type: "error",
        requestId: 1,
        message: "rebuild-failed: stale context",
      });
    });
    // A late error from an older request must not log against the new one.
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();

    act(() => {
      respond(fake, {
        type: "error",
        requestId: 2,
        message: "rebuild-failed: current",
      });
    });
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("current") as unknown as string,
      }),
    );

    // Errors with NO requestId (worker crash) still log.
    act(() => {
      respond(fake, { type: "error", message: "worker-crashed" });
    });
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(2);
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
        context: DEFAULT_CTX,
      });

      await flush(250);
      expect(responses).toEqual([{ type: "results", requestId: 1, hits: [] }]);
      expect(WorkerCtor).toHaveBeenCalledTimes(1);
      executor.terminate();
    });

    it("20b. a failing recreate answers the pending QUERY with one correlated error (never dropped silently)", () => {
      const { instances, WorkerCtor } = installFakeWorker();
      const executor = createSearchExecutor();
      const responses: SearchWorkerResponse[] = [];
      executor.onResponse((r) => responses.push(r));
      WorkerCtor.mockImplementation(() => {
        throw new DOMException("bad url", "SyntaxError");
      });
      instances[0]?.onerror?.({ message: "boom" } as ErrorEvent);
      responses.length = 0; // drop the synthetic crash error

      // dead stays true, so the next post retries the create and fails again.
      executor.post({
        type: "query",
        requestId: 7,
        query: "x",
        limit: 10,
        userEmail: "default",
        context: DEFAULT_CTX,
      });
      expect(responses).toEqual([
        {
          type: "error",
          requestId: 7,
          message: "worker-recreate-failed",
        },
      ]);

      executor.post({
        type: "query",
        requestId: 8,
        query: "x",
        limit: 10,
        userEmail: "default",
        context: DEFAULT_CTX,
      });
      // Exactly one correlated error per failed post — no duplicates, no hang.
      expect(responses).toHaveLength(2);
      expect(responses[1]).toEqual({
        type: "error",
        requestId: 8,
        message: "worker-recreate-failed",
      });
      // initial create + 2 retried creates (the failed one is not cached).
      expect(WorkerCtor).toHaveBeenCalledTimes(3);
      executor.terminate();
    });

    it("20c. a failing recreate drops non-query messages silently (invalidate has no response contract)", () => {
      const { instances, WorkerCtor } = installFakeWorker();
      const executor = createSearchExecutor();
      const responses: SearchWorkerResponse[] = [];
      executor.onResponse((r) => responses.push(r));
      WorkerCtor.mockImplementation(() => {
        throw new DOMException("bad url", "SyntaxError");
      });
      instances[0]?.onerror?.({ message: "boom" } as ErrorEvent);
      responses.length = 0;

      executor.post({ type: "invalidate" });
      expect(responses).toEqual([]);
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
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(250);
    expect(view.result.current.hits.map((h) => h.id)).toEqual(["mine"]);
    view.unmount();
  });

  // ---- Phase A: root context frames + metadata invalidation (B4/I1) ------

  function makeContext(
    overrides: Partial<Parameters<typeof useSearchWorker>[2]> = {},
  ) {
    return {
      mode: "global" as const,
      rootIds: ["root"],
      sortField: "relevance" as const,
      sortDir: "desc" as const,
      ...overrides,
    };
  }

  it("22. context rides on the query frame (mode/roots/sort reach the worker)", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const context = makeContext({
      mode: "recursive",
      rootIds: ["folder-A"],
      currentFolderId: "folder-A",
      sortField: "name",
      sortDir: "asc",
    });
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: { q: "song", ctx: context },
    });
    await flush(200);
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]).toMatchObject({
      type: "query",
      query: "song",
      userEmail: "default",
      context: {
        mode: "recursive",
        rootIds: ["folder-A"],
        currentFolderId: "folder-A",
        sortField: "name",
        sortDir: "asc",
      },
    });
    view.unmount();
  });

  it("23. changing mode/sort re-queries immediately (query unchanged, new requestId)", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: {
        q: "song",
        ctx: makeContext({ mode: "global", sortField: "relevance" }),
      },
    });
    await flush(200);
    expect(fake.posted).toHaveLength(1);

    act(() => {
      view.rerender({
        q: "song",
        ctx: makeContext({ mode: "recursive", sortField: "relevance" }),
      });
    });
    await flush(200);
    expect(fake.posted).toHaveLength(2);
    expect(fake.posted[1]).toMatchObject({
      type: "query",
      query: "song",
      context: { mode: "recursive" },
    });

    act(() => {
      view.rerender({
        q: "song",
        ctx: makeContext({ mode: "recursive", sortField: "name" }),
      });
    });
    await flush(200);
    expect(fake.posted).toHaveLength(3);
    expect(fake.posted[2]).toMatchObject({
      context: { mode: "recursive", sortField: "name" },
    });
    view.unmount();
  });

  // ---- Stale results / request identity (FIX 1) ---------------------------

  it("28. context change hides the previous hits IMMEDIATELY (before debounce)", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const hitOld = makeHit("old", "old.mp3", 1);
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: { q: "song", ctx: makeContext({ mode: "global" }) },
    });
    await flush(200);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitOld] });
    });
    expect(view.result.current.hits).toEqual([hitOld]);

    act(() => {
      view.rerender({
        q: "song",
        ctx: makeContext({ mode: "recursive", currentFolderId: "folder-A" }),
      });
    });
    // No timer advance: the identity changed, so the old scoped hits must be
    // gone in the SAME render (render-derived, not effect-derived).
    expect(view.result.current.hits).toEqual([]);
    view.unmount();
  });

  it("29. an in-flight response from the OLD identity is dropped even before the new debounce fires", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: { q: "song", ctx: makeContext({ rootIds: ["root"] }) },
    });
    await flush(200); // requestId 1 in flight
    act(() => {
      view.rerender({ q: "song", ctx: makeContext({ rootIds: ["other"] }) });
    });
    act(() => {
      // The stale request answers inside the debounce window.
      respond(fake, {
        type: "results",
        requestId: 1,
        hits: [makeHit("stale", "stale.mp3", 1)],
      });
    });
    expect(view.result.current.hits).toEqual([]);
    view.unmount();
  });

  it("30. a late response from an old identity never overwrites the new identity's hits", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: { q: "song", ctx: makeContext({ mode: "global" }) },
    });
    await flush(200);
    act(() => {
      view.rerender({ q: "song", ctx: makeContext({ mode: "recursive" }) });
    });
    await flush(200); // requestId 2 in flight for the NEW identity
    const hitNew = makeHit("new", "new.mp3", 2);
    act(() => {
      respond(fake, { type: "results", requestId: 2, hits: [hitNew] });
    });
    expect(view.result.current.hits).toEqual([hitNew]);
    act(() => {
      respond(fake, {
        type: "results",
        requestId: 1,
        hits: [makeHit("stale", "stale.mp3", 1)],
      });
    });
    expect(view.result.current.hits).toEqual([hitNew]);
    view.unmount();
  });

  it("31. account switch (reactive store) clears hits immediately and sends the new owner", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    act(() => {
      useAuthStore.setState({
        userProfile: { name: "Me", email: "me@x", picture: "" },
      });
    });
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200);
    expect(fake.posted[0]).toMatchObject({ userEmail: "me@x" });
    act(() => {
      respond(fake, {
        type: "results",
        requestId: 1,
        hits: [makeHit("mine", "mine.mp3", 1)],
      });
    });
    expect(view.result.current.hits).toHaveLength(1);

    act(() => {
      useAuthStore.setState({
        userProfile: { name: "Other", email: "other@x", picture: "" },
      });
    });
    // Different account = different identity: the previous owner's hits are
    // never exposed while the new query is in flight.
    expect(view.result.current.hits).toEqual([]);
    await flush(200);
    expect(fake.posted[1]).toMatchObject({ userEmail: "other@x" });
    view.unmount();
  });

  it("32. query/folder/roots/sort changes each invalidate immediately", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const hit = makeHit("h", "h.mp3", 1);
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: {
        q: "song",
        ctx: makeContext({ sortField: "relevance" }),
      },
    });
    await flush(200);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hit] });
    });
    expect(view.result.current.hits).toEqual([hit]);

    const changes: Array<{
      q: string;
      ctx: Parameters<typeof useSearchWorker>[2];
    }> = [
      { q: "songs", ctx: makeContext({ sortField: "relevance" }) },
      { q: "songs", ctx: makeContext({ sortField: "name" }) },
      { q: "songs", ctx: makeContext({ sortField: "name", rootIds: ["r2"] }) },
      {
        q: "songs",
        ctx: makeContext({
          sortField: "name",
          rootIds: ["r2"],
          currentFolderId: "f1",
        }),
      },
    ];
    let prev = view.result.current.hits;
    for (const change of changes) {
      act(() => {
        view.rerender({ q: change.q, ctx: change.ctx });
      });
      expect(view.result.current.hits).toEqual([]);
      expect(prev).not.toBe(view.result.current.hits);
      prev = view.result.current.hits;
    }
    view.unmount();
  });

  it("24. metadataCache put marks the index stale: the next query sees the new title", async () => {
    await db.files.bulkPut([makeFile("f-meta", "01 - raw name.mp3")]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "new title" },
    });
    await flush(250);
    // No metadata yet: filename does not match the title query.
    expect(view.result.current.hits).toEqual([]);

    // Real metadata lands via putCacheEntry-style row put (production path:
    // setCache -> db.metadataCache.put fires the 'creating'/'updating' hook).
    await db.metadataCache.put({
      key: "metadata_f-meta",
      entry: {
        version: 2,
        data: {
          title: "New Title",
          artist: "Some Artist",
          duration: 0,
          durationEstimated: true,
          pictureData: null,
          pictureDataFull: null,
          v: 5,
        },
        ts: Date.now(),
      },
    });
    await flush(320); // invalidation throttle (300ms) elapses -> stale

    // The stale flag rides on the WORKER module state (lazy rebuild): the
    // next query that reaches the executor rebuilds with fresh metadata.
    // The user typing a refined query is the production trigger (same-string
    // rerenders do not re-run the debounce effect — React deps unchanged).
    // "titled" keeps the AND alive (prefix of nothing extra) while changing
    // the deps so the debounce effect re-fires.
    act(() => {
      view.rerender({ q: "new titled" });
    });
    await flush(250); // debounce + rebuild with the fresh metadata
    const ids = view.result.current.hits.map((h) => h.id);
    expect(ids).toContain("f-meta");
    const hit = view.result.current.hits.find((h) => h.id === "f-meta");
    expect(hit?.title).toBe("New Title");
    expect(hit?.artist).toBe("Some Artist");
    view.unmount();
  });

  it("25. metadataCache delete invalidates too (evicted title disappears from search)", async () => {
    await db.files.bulkPut([makeFile("f-del", "01 - raw.mp3")]);
    await db.metadataCache.put({
      key: "metadata_f-del",
      entry: {
        version: 2,
        data: {
          title: "Zed Title",
          artist: null as unknown as string,
          duration: 0,
          durationEstimated: true,
          pictureData: null,
          pictureDataFull: null,
          v: 5,
        },
        ts: Date.now(),
      },
    });
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "zed title" },
    });
    await flush(250);
    expect(view.result.current.hits.map((h) => h.id)).toContain("f-del");

    // Production delete paths: LRU evict (delete) / wipePersistedMetadataCache
    // (clear) — both fire the 'deleting' hook.
    await db.metadataCache.delete("metadata_f-del");
    await flush(320);

    // Refined query reaches the executor -> stale index rebuilds WITHOUT the
    // evicted metadata: the title no longer matches. "titled" keeps the AND
    // alive while changing the deps so the debounce effect re-fires.
    act(() => {
      view.rerender({ q: "zed titled" });
    });
    await flush(250);
    expect(view.result.current.hits.map((h) => h.id)).not.toContain("f-del");
    view.unmount();
  });

  it("26. coalesced metadata burst collapses into ONE invalidate (throttle holds)", async () => {
    await db.files.bulkPut([makeFile("f-c", "Coalesce target.mp3")]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "coalesce" },
    });
    await flush(250);
    // Drive the REAL inline path with a burst of metadata puts and confirm
    // the index rebuilds once and the final state is fresh (the throttle
    // guarantees at most 1 invalidate per 300ms window — verified by the
    // final result being correct).
    for (let i = 0; i < 5; i += 1) {
      await db.metadataCache.put({
        key: `metadata_f-c`,
        entry: {
          version: 2,
          data: {
            title: `Coalesce Title v${String(i)}`,
            artist: null as unknown as string,
            duration: 0,
            durationEstimated: true,
            pictureData: null,
            pictureDataFull: null,
            v: 5,
          },
          ts: Date.now(),
        },
      });
    }
    await flush(320);

    act(() => {
      view.rerender({ q: "coalesce titled v4" });
    });
    await flush(250);
    // The LAST metadata state won (coalesced into one fresh rebuild).
    const hit = view.result.current.hits.find((h) => h.id === "f-c");
    expect(hit?.title).toBe("Coalesce Title v4");
    view.unmount();
  });

  it("27. inline fallback answers the SAME root-scoped shape as the worker path", async () => {
    await db.files.bulkPut([
      // The root folder doc itself must be indexed for membership to resolve.
      makeFile("root", "Root", {
        isFolder: true,
        mimeType: "application/vnd.google-apps.folder",
      }),
      makeFile("in-root", "Song in root.mp3"),
      { ...makeFile("out-root", "Song out.mp3"), parentId: "elsewhere" },
    ]);
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: {
        q: "song",
        ctx: makeContext({ rootIds: ["root"] }),
      },
    });
    await flush(250);
    // in-root is a child of "root" (default parentId); out-root is not.
    const ids = view.result.current.hits.map((h) => h.id);
    expect(ids).toContain("in-root");
    expect(ids).not.toContain("out-root");

    // Empty roots fail closed through the inline path too.
    const view2 = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: {
        q: "song",
        ctx: makeContext({ rootIds: [] }),
      },
    });
    await flush(250);
    expect(view2.result.current.hits).toEqual([]);
    view.unmount();
    view2.unmount();
  });

  // ---- Result lifecycle: no resurrection, failure clears (Phase 2) --------

  it("33. clear then retype the SAME query: old hits never resurrect", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200); // requestId 1 sent
    const hitA = makeHit("a", "song-a.mp3", 2);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitA] });
    });
    expect(view.result.current.hits).toEqual([hitA]);

    act(() => {
      view.rerender({ q: "" });
    });
    expect(view.result.current.hits).toEqual([]);
    await flush(200); // empty query never posts
    expect(fake.posted).toHaveLength(1);

    act(() => {
      view.rerender({ q: "song" }); // identical query + scope as the first one
    });
    // Same identity string as the stored result, but a NEW epoch: the old
    // hits must not be exposed while the new request is still pending.
    expect(view.result.current.hits).toEqual([]);
    await flush(200); // requestId 3 sent
    expect(fake.posted).toHaveLength(2);

    const hitB = makeHit("b", "song-b.mp3", 3);
    act(() => {
      respond(fake, { type: "results", requestId: 3, hits: [hitB] });
    });
    expect(view.result.current.hits).toEqual([hitB]);
    view.unmount();
  });

  it("34. global -> recursive -> global: hits stay [] until the returning request resolves", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: { q: "song", ctx: makeContext({ mode: "global" }) },
    });
    await flush(200);
    const hitGlobal = makeHit("g", "global.mp3", 2);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitGlobal] });
    });
    expect(view.result.current.hits).toEqual([hitGlobal]);

    act(() => {
      view.rerender({
        q: "song",
        ctx: makeContext({ mode: "recursive", currentFolderId: "folder-A" }),
      });
    });
    expect(view.result.current.hits).toEqual([]);
    await flush(200); // requestId 2 (recursive) sent

    act(() => {
      view.rerender({ q: "song", ctx: makeContext({ mode: "global" }) });
    });
    // Back to the FIRST identity: still [] (epoch moved on), no resurrection.
    expect(view.result.current.hits).toEqual([]);
    await flush(200); // requestId 3 (global again) sent

    const hitGlobalNew = makeHit("g2", "global-new.mp3", 4);
    act(() => {
      respond(fake, { type: "results", requestId: 3, hits: [hitGlobalNew] });
    });
    expect(view.result.current.hits).toEqual([hitGlobalNew]);
    view.unmount();
  });

  it("35. context change and return: old hits do not resurrect on return", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q, ctx }) => useSearchWorker(q, 10, ctx), {
      initialProps: { q: "song", ctx: makeContext({ rootIds: ["root"] }) },
    });
    await flush(200);
    const hitOld = makeHit("old", "old.mp3", 1);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitOld] });
    });
    expect(view.result.current.hits).toEqual([hitOld]);

    act(() => {
      view.rerender({ q: "song", ctx: makeContext({ rootIds: ["other"] }) });
    });
    expect(view.result.current.hits).toEqual([]);

    act(() => {
      view.rerender({ q: "song", ctx: makeContext({ rootIds: ["root"] }) });
    });
    expect(view.result.current.hits).toEqual([]);
    await flush(200);
    expect(fake.posted).toHaveLength(2);

    const hitFresh = makeHit("fresh", "fresh.mp3", 2);
    act(() => {
      respond(fake, { type: "results", requestId: 3, hits: [hitFresh] });
    });
    expect(view.result.current.hits).toEqual([hitFresh]);
    view.unmount();
  });

  it("36. a failing CURRENT request clears the hits and still logs", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200);
    const hitOld = makeHit("old", "old.mp3", 1);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitOld] });
    });
    expect(view.result.current.hits).toEqual([hitOld]);

    // New query resolves first, THEN the same request fails (e.g. a retried
    // rebuild): the hits that query produced must not survive its failure.
    act(() => {
      view.rerender({ q: "song rebuild" });
    });
    await flush(200); // requestId 2 sent
    const hitB = makeHit("b", "b.mp3", 3);
    act(() => {
      respond(fake, { type: "results", requestId: 2, hits: [hitB] });
    });
    expect(view.result.current.hits).toEqual([hitB]);

    act(() => {
      respond(fake, {
        type: "error",
        requestId: 2,
        message: "rebuild-failed: index boom",
      });
    });
    expect(view.result.current.hits).toEqual([]);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useSearchWorker",
        message: expect.stringContaining("index boom") as unknown as string,
      }),
    );

    // A requestId-less error (worker crash) is a safe clear as well: the
    // survivor results prove it is not just "[] because identity changed".
    act(() => {
      view.rerender({ q: "song after crash" });
    });
    await flush(200); // requestId 3 sent
    act(() => {
      respond(fake, {
        type: "results",
        requestId: 3,
        hits: [makeHit("c", "c.mp3", 4)],
      });
    });
    expect(view.result.current.hits).toHaveLength(1);
    act(() => {
      respond(fake, { type: "error", message: "worker-crashed" });
    });
    expect(view.result.current.hits).toEqual([]);
    view.unmount();
  });

  it("37. an obsolete request failing after B succeeded keeps B's hits and logs nothing", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "a" },
    });
    await flush(200); // requestId 1 (A) in flight
    act(() => {
      view.rerender({ q: "b" });
    });
    await flush(200); // requestId 2 (B) in flight

    const hitB = makeHit("b", "b.mp3", 2);
    act(() => {
      respond(fake, { type: "results", requestId: 2, hits: [hitB] });
    });
    expect(view.result.current.hits).toEqual([hitB]);

    vi.mocked(captureError).mockClear();
    act(() => {
      respond(fake, {
        type: "error",
        requestId: 1,
        message: "rebuild-failed: obsolete A",
      });
    });
    // Obsolete failure: neither clears B's hits nor logs.
    expect(view.result.current.hits).toEqual([hitB]);
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
    view.unmount();
  });

  // ---- Phase B: live refresh of the ACTIVE query -------------------------

  const INVALIDATE_MS = 300;
  const DEBOUNCE_MS = 150;

  // The refresh is deliberately TWO windows: the 300ms trailing coalescer
  // (invalidate lands here) and then the ordinary 150ms dispatch debounce for
  // the re-posted query. Flush both, plus the inline rebuild round-trip.
  async function flushRefresh(extra = 0): Promise<void> {
    await flush(INVALIDATE_MS + 50);
    await flush(DEBOUNCE_MS + 50 + extra);
    await flush(200);
  }

  function postCount(
    fake: FakeExecutor,
    type: SearchWorkerRequest["type"],
  ): number {
    return fake.posted.filter((m) => m.type === type).length;
  }

  it("39. a db.files insert refreshes the ACTIVE query without retyping (invalidate then new query)", async () => {
    await db.files.bulkPut([makeFile("f1", "Anh dong vien.mp3")]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "anh" },
    });
    await flush(250);
    expect(view.result.current.hits.map((h) => h.id)).toEqual(["f1"]);

    // No rerender, no typing: the write alone must refresh the live results.
    await db.files.put(makeFile("f2", "Anh yeu em.mp3"));
    await flushRefresh();

    expect(view.result.current.hits.map((h) => h.id)).toContain("f2");
    view.unmount();
  });

  it("40. a db.files delete refreshes too (deleted row disappears from live hits)", async () => {
    await db.files.bulkPut([
      makeFile("keep", "Anh keep.mp3"),
      makeFile("gone", "Anh gone.mp3"),
    ]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "anh" },
    });
    await flush(250);
    expect(view.result.current.hits.map((h) => h.id).sort()).toEqual([
      "gone",
      "keep",
    ]);

    await db.files.delete(["default", "gone"]);
    await flushRefresh();

    expect(view.result.current.hits.map((h) => h.id)).toEqual(["keep"]);
    view.unmount();
  });

  it("41. refresh posts invalidate BEFORE the new query (same executor, ordered)", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200); // requestId 1
    expect(fake.posted.map((m) => m.type)).toEqual(["query"]);

    await db.files.put(makeFile("f-new", "song new.mp3"));
    await flushRefresh(); // trailing 300ms + query debounce 150ms

    expect(fake.posted.map((m) => m.type)).toEqual([
      "query",
      "invalidate",
      "query",
    ]);
    const refreshed = fake.posted[2];
    const initial = fake.posted[0];
    expect(refreshed).toMatchObject({ type: "query", query: "song" });
    if (refreshed?.type !== "query" || initial?.type !== "query")
      throw new Error("expected a query frame");
    expect(refreshed.requestId).toBeGreaterThan(initial.requestId);
    view.unmount();
  });

  it("42. an empty query refreshes the index but never posts a query", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "" },
    });
    await flush(200);
    expect(fake.posted).toEqual([]);

    await db.files.put(makeFile("f-empty", "whatever.mp3"));
    await flushRefresh();

    expect(fake.posted.map((m) => m.type)).toEqual(["invalidate"]);
    view.unmount();
  });

  it("43. a burst of writes coalesces into ONE invalidate + ONE refresh query", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200);
    expect(postCount(fake, "query")).toBe(1);

    // Writes land inside the trailing window: each one RESETS the timer.
    for (let i = 0; i < 5; i += 1) {
      await db.files.put(
        makeFile(`burst-${String(i)}`, `song ${String(i)}.mp3`),
      );
      await flush(50);
    }
    await flushRefresh();

    expect(postCount(fake, "invalidate")).toBe(1);
    expect(postCount(fake, "query")).toBe(2); // initial + exactly one refresh
    view.unmount();
  });

  it("44. sync progress invalidates without refreshing; sync complete refreshes once", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200);
    const queriesAfterMount = postCount(fake, "query");

    for (let i = 0; i < 4; i += 1) {
      act(() => {
        window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAMES.progress));
      });
      await flush(400); // page-by-page progress, each one throttled
    }
    // Sync progress must never rebuild+requery (per-page storm guard).
    expect(postCount(fake, "query")).toBe(queriesAfterMount);
    expect(postCount(fake, "invalidate")).toBeGreaterThanOrEqual(1);

    const invalidatesBeforeComplete = postCount(fake, "invalidate");
    act(() => {
      window.dispatchEvent(new CustomEvent(SYNC_EVENT_NAMES.complete));
    });
    await flushRefresh();

    expect(postCount(fake, "query")).toBe(queriesAfterMount + 1);
    expect(postCount(fake, "invalidate")).toBeGreaterThanOrEqual(
      invalidatesBeforeComplete + 1,
    );
    view.unmount();
  });

  it("45. refresh keeps the OLD hits visible while pending and adopts the new response", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const hitOld = makeHit("old", "song-old.mp3", 1);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitOld] });
    });
    expect(view.result.current.hits).toEqual([hitOld]);

    await db.files.put(makeFile("f-refresh", "song refresh.mp3"));
    await flushRefresh(); // refresh query (requestId 2) is in flight
    // Same identity, same epoch: no flicker to [] while the refresh runs.
    expect(view.result.current.hits).toEqual([hitOld]);

    const hitFresh = makeHit("fresh", "song-fresh.mp3", 2);
    act(() => {
      respond(fake, { type: "results", requestId: 2, hits: [hitFresh] });
    });
    expect(view.result.current.hits).toEqual([hitFresh]);
    view.unmount();
  });

  it("46. a stale (pre-refresh) response cannot replace the refreshed hits", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200); // requestId 1
    const hitOld = makeHit("old", "song-old.mp3", 1);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitOld] });
    });

    await db.files.put(makeFile("f-stale", "song stale.mp3"));
    await flushRefresh(); // requestId 2 in flight
    const hitFresh = makeHit("fresh", "song-fresh.mp3", 2);
    act(() => {
      respond(fake, { type: "results", requestId: 2, hits: [hitFresh] });
    });
    expect(view.result.current.hits).toEqual([hitFresh]);

    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitOld] });
    });
    expect(view.result.current.hits).toEqual([hitFresh]);
    view.unmount();
  });

  it("47. a failing refresh clears the hits and logs a warn", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200);
    const hitOld = makeHit("old", "song-old.mp3", 1);
    act(() => {
      respond(fake, { type: "results", requestId: 1, hits: [hitOld] });
    });
    expect(view.result.current.hits).toEqual([hitOld]);

    await db.files.put(makeFile("f-fail", "song fail.mp3"));
    await flushRefresh(); // requestId 2 in flight
    act(() => {
      respond(fake, {
        type: "error",
        requestId: 2,
        message: "rebuild-failed: refresh boom",
      });
    });
    expect(view.result.current.hits).toEqual([]);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useSearchWorker",
        message: expect.stringContaining("refresh boom") as unknown as string,
      }),
    );
    view.unmount();
  });

  it("48. unmount clears the pending refresh timer and posts nothing afterwards", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200);
    expect(fake.posted).toHaveLength(1);

    await db.files.put(makeFile("f-late", "song late.mp3"));
    // The trailing refresh timer is armed but not fired yet.
    view.unmount();
    await flush(2000);
    expect(fake.posted).toHaveLength(1);
    expect(fake.terminateSpy).toHaveBeenCalledTimes(1);
  });

  it("49. metadataCache write refreshes live hits without retyping", async () => {
    await db.files.bulkPut([makeFile("f-meta-live", "01 - raw name.mp3")]);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "new title" },
    });
    await flush(250);
    expect(view.result.current.hits).toEqual([]);

    await db.metadataCache.put({
      key: "metadata_f-meta-live",
      entry: {
        version: 2,
        data: {
          title: "New Title",
          artist: "Some Artist",
          duration: 0,
          durationEstimated: true,
          pictureData: null,
          pictureDataFull: null,
          v: 5,
        },
        ts: Date.now(),
      },
    });
    await flushRefresh();

    const ids = view.result.current.hits.map((h) => h.id);
    expect(ids).toEqual(["f-meta-live"]);
    expect(view.result.current.hits[0]?.title).toBe("New Title");
    view.unmount();
  });

  it("50. metadataCache delete refreshes live hits too (evicted title disappears)", async () => {
    await db.files.bulkPut([makeFile("f-meta-gone", "01 - raw.mp3")]);
    await db.metadataCache.put({
      key: "metadata_f-meta-gone",
      entry: {
        version: 2,
        data: {
          title: "Zed Title",
          artist: null as unknown as string,
          duration: 0,
          durationEstimated: true,
          pictureData: null,
          pictureDataFull: null,
          v: 5,
        },
        ts: Date.now(),
      },
    });
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "zed title" },
    });
    await flush(250);
    expect(view.result.current.hits.map((h) => h.id)).toEqual(["f-meta-gone"]);

    await db.metadataCache.delete("metadata_f-meta-gone");
    await flushRefresh();

    expect(view.result.current.hits).toEqual([]);
    view.unmount();
  });

  it("51. hook-level: crash + recreate failure surfaces a correlated error (no hang) and recovers", async () => {
    const { instances, WorkerCtor } = installFakeWorker();
    setSearchExecutorFactoryForTests(createSearchExecutor);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "song" },
    });
    await flush(200); // requestId 1 reaches the fake worker
    expect(instances).toHaveLength(1);
    expect(instances[0]?.postMessage).toHaveBeenCalledTimes(1);

    // Worker dies; every recreate throws, so the refresh cannot be delivered.
    instances[0]?.onerror?.({ message: "boom" } as ErrorEvent);
    WorkerCtor.mockImplementation(() => {
      throw new DOMException("bad url", "SyntaxError");
    });
    act(() => {
      view.rerender({ q: "song live" });
    });
    await flush(200);

    // The query was not silently dropped: the hook saw the correlated error,
    // failed closed and logged it — no pending state, nothing hangs.
    expect(view.result.current.hits).toEqual([]);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useSearchWorker",
        message: expect.stringContaining(
          "worker-recreate-failed",
        ) as unknown as string,
      }),
    );

    // Recovery: constructor works again -> the next query lands on a fresh
    // worker and its results are exposed.
    const working: FakeWorkerInstance = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    WorkerCtor.mockImplementation(function () {
      instances.push(working);
      return working;
    });
    act(() => {
      view.rerender({ q: "song recovered" });
    });
    await flush(200);
    expect(working.postMessage).toHaveBeenCalledTimes(1);
    const frame = working.postMessage.mock.calls[0]?.[0] as
      SearchWorkerRequest | undefined;
    expect(frame).toMatchObject({ type: "query", query: "song recovered" });
    const requestId = frame?.type === "query" ? frame.requestId : -1;
    act(() => {
      working.onmessage?.({
        data: {
          type: "results",
          requestId,
          hits: [makeHit("ok", "song recovered.mp3", 1)],
        },
      } as MessageEvent);
    });
    expect(view.result.current.hits.map((h) => h.id)).toEqual(["ok"]);
    view.unmount();
  });

  it("38. an obsolete success after B succeeded does not replace B's hits", async () => {
    const fake = createFakeExecutor();
    setSearchExecutorFactoryForTests(() => fake);
    const view = renderHook(({ q }) => useSearchWorker(q, 10, DEFAULT_CTX), {
      initialProps: { q: "a" },
    });
    await flush(200); // requestId 1 (A) in flight
    act(() => {
      view.rerender({ q: "b" });
    });
    await flush(200); // requestId 2 (B) in flight

    const hitB = makeHit("b", "b.mp3", 2);
    act(() => {
      respond(fake, { type: "results", requestId: 2, hits: [hitB] });
    });
    expect(view.result.current.hits).toEqual([hitB]);

    act(() => {
      respond(fake, {
        type: "results",
        requestId: 1,
        hits: [makeHit("a", "a.mp3", 1)],
      });
    });
    expect(view.result.current.hits).toEqual([hitB]);
    view.unmount();
  });
});
