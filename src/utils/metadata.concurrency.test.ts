// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CachedMetadata } from "./metadata";
import {
  getTrackMetadata,
  clearAllMetadataCache,
  cacheTrackMetadata,
  METADATA_LRU_KEY,
  V_PLACEHOLDER,
} from "./metadata";
import { db } from "../db/db";
import type { MetadataCacheRow } from "../db/db";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Retarget persistence to an in-memory fake of db.metadataCache.
// The real db import is replaced so no IndexedDB/fake-indexeddb is needed.
const memoryStore = new Map<string, MetadataCacheRow>();
vi.mock("../db/db", () => ({
  db: {
    metadataCache: {
      get: (key: string) => Promise.resolve(memoryStore.get(key)),
      put: (row: MetadataCacheRow) => {
        memoryStore.set(row.key, row);
        return Promise.resolve();
      },
      delete: (key: string) => {
        memoryStore.delete(key);
        return Promise.resolve();
      },
    },
  },
}));

const { invoke } = await import("@tauri-apps/api/core");

class ConcurrencyQueue {
  private queue: (() => void)[] = [];
  private activeCount = 0;
  private readonly concurrency: number;
  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }
  async enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Promise((resolve, reject) => {
      const run = async () => {
        if (signal?.aborted) {
          this.activeCount--;
          this.dequeue();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        try {
          resolve(await task());
        } catch (e: unknown) {
          reject(e instanceof Error ? e : new Error(String(e)));
        } finally {
          this.activeCount--;
          this.dequeue();
        }
      };
      if (this.activeCount < this.concurrency) {
        this.activeCount++;
        void run();
      } else {
        this.queue.push(() => {
          void run();
        });
      }
    });
  }
  private dequeue() {
    if (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const next = this.queue.shift();
      if (next) {
        this.activeCount++;
        next();
      }
    }
  }
}

describe("ConcurrencyQueue deadlock", () => {
  it("blocks all subsequent tasks when all slots are occupied by hanging tasks", async () => {
    const queue = new ConcurrencyQueue(2);

    const hangingTask = () => new Promise<string>(() => {});

    const fastTask = () => Promise.resolve("done");

    void queue.enqueue(hangingTask);

    let secondResolved = false;
    void queue.enqueue(hangingTask).then(() => {
      secondResolved = true;
    });

    let thirdResolved = false;
    void queue.enqueue(fastTask).then(() => {
      thirdResolved = true;
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(secondResolved).toBe(false);
    expect(thirdResolved).toBe(false);
  });

  it("direct calls (no queue) process independently even when some tasks hang", async () => {
    const hangingTask = () => new Promise<string>(() => {});

    const fastTask = () => Promise.resolve("done");

    void hangingTask();
    void hangingTask();

    const fastResult = await fastTask();
    expect(fastResult).toBe("done");
  });
});

describe("getTrackMetadata caching", () => {
  beforeEach(() => {
    clearAllMetadataCache();
    vi.mocked(invoke).mockReset();
  });

  it("returns a placeholder entry on first call and never invokes IPC (DB commands removed)", async () => {
    const r1 = await getTrackMetadata("file-1", "tok", 1000, "song.mp3");
    expect(r1.title).toBe("song");
    expect(r1.artist).toBe("Unknown Artist");
    expect(r1.duration).toBe(0);
    expect(r1.durationEstimated).toBe(true);
    expect(r1.v).toBe(V_PLACEHOLDER);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("returns the same entry from memory cache on second call (no IPC)", async () => {
    // Seed a REAL cached entry (not a placeholder): the same-reference
    // guarantee holds for real entries. A placeholder produced by a transient
    // NETWORK failure is intentionally NOT cached anymore (range-fetch fix:
    // it would pin 00:00:00 until app reload) — that case is asserted in
    // metadata.test.ts "does not lock the placeholder after a transient
    // network failure".
    cacheTrackMetadata("file-1", makeEntry());
    const r1 = await getTrackMetadata("file-1", "tok", 1000, "song.mp3");

    vi.mocked(invoke).mockClear();
    const r2 = await getTrackMetadata("file-1", "tok", 1000, "song.mp3");

    expect(r2).toBe(r1);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});

function makeEntry(): CachedMetadata {
  return {
    title: "t",
    artist: "a",
    duration: 1,
    durationEstimated: false,
    pictureData: new Uint8Array([1, 2, 3]),
    pictureDataFull: new Uint8Array([9, 9, 9, 9]),
    v: 9,
  };
}

const flushPromises = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("lruKeys + cache invalidation hardening", () => {
  afterEach(() => {
    localStorage.removeItem(METADATA_LRU_KEY);
  });

  it("clearAllMetadataCache resets lruKeys so cleared keys are never re-persisted", async () => {
    localStorage.removeItem(METADATA_LRU_KEY);
    clearAllMetadataCache();

    cacheTrackMetadata("stale-a", makeEntry());
    await flushPromises();
    expect(
      JSON.parse(localStorage.getItem(METADATA_LRU_KEY) || "[]"),
    ).toContain("metadata_stale-a");

    clearAllMetadataCache();

    cacheTrackMetadata("fresh-b", makeEntry());
    await flushPromises();

    const after = JSON.parse(
      localStorage.getItem(METADATA_LRU_KEY) || "[]",
    ) as string[];
    expect(after).not.toContain("metadata_stale-a");
    expect(after).toContain("metadata_fresh-b");
  });

  it("generation guard: an in-flight setCache after clear is a no-op", async () => {
    localStorage.removeItem(METADATA_LRU_KEY);
    clearAllMetadataCache();

    const metadataCacheTable = db.metadataCache as unknown as {
      get: (key: string) => Promise<unknown>;
      put: (row: unknown) => Promise<unknown>;
    };
    const originalGet = metadataCacheTable.get;
    const originalPut = metadataCacheTable.put;
    let resolveGet!: (v: unknown) => void;
    const pendingGet = new Promise<unknown>((resolve) => {
      resolveGet = resolve;
    });
    const putMock = vi.fn(() => Promise.resolve());
    metadataCacheTable.get = () => pendingGet;
    metadataCacheTable.put = putMock;

    try {
      cacheTrackMetadata("gen-guard", makeEntry());
      await flushPromises();
      expect(memoryStore.has("metadata_gen-guard")).toBe(false);

      clearAllMetadataCache();
      metadataCacheTable.get = originalGet;
      resolveGet(undefined);
      await flushPromises();

      expect(memoryStore.has("metadata_gen-guard")).toBe(false);
      expect(putMock).not.toHaveBeenCalled();
      expect(localStorage.getItem(METADATA_LRU_KEY)).toBeNull();
    } finally {
      metadataCacheTable.get = originalGet;
      metadataCacheTable.put = originalPut;
    }
  });

  it("getCacheEntry treats entries with a stale CACHE_VERSION as a miss", async () => {
    localStorage.removeItem(METADATA_LRU_KEY);
    clearAllMetadataCache();
    vi.mocked(invoke).mockReset();

    memoryStore.set("metadata_stale-ver", {
      key: "metadata_stale-ver",
      entry: { version: 1, data: makeEntry(), ts: Date.now() },
    });

    const r = await getTrackMetadata("stale-ver", "tok", 1000, "stale.mp3");
    expect(r.title).toBe("stale");
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("loads corrupt lruKeys JSON (non-array) from localStorage without crashing", async () => {
    localStorage.setItem(METADATA_LRU_KEY, JSON.stringify({}));
    vi.resetModules();
    const mod = await import("./metadata");

    mod.cacheTrackMetadata("corrupt-1", makeEntry());
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const stored = localStorage.getItem(METADATA_LRU_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored || "") as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain("metadata_corrupt-1");
  });
});
