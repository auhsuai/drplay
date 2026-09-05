import { afterEach, describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

// Behavioral tests for the Slice-1 byte-range cache (IndexedDB) inside
// public/sw.js — same sandbox pattern as swMime.test.ts / swTokenRetry.test.ts:
// the raw sw.js source runs via new Function("self", ...) with a fake `self`,
// global fetch stubbed, plus a minimal fake IndexedDB covering exactly what
// the byte cache uses (open+upgrade, 3 stores, get/put/delete/getAll).

// ---- Fake IndexedDB -------------------------------------------------------

type FakeError = { name: string; message: string };

interface FakeDbConfig {
  failPut?: FakeError;
  openError?: FakeError;
}

class FakeRequest<T = unknown> {
  result: T | undefined = undefined;
  error: FakeError | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private settled = false;
  private readonly tx: FakeTransaction;
  private readonly setup: () => T;
  constructor(tx: FakeTransaction, setup: () => T) {
    this.tx = tx;
    this.setup = setup;
    tx.register();
  }
  execute(): void {
    let succeeded = true;
    try {
      this.result = this.setup();
    } catch (err) {
      succeeded = false;
      this.error = err as FakeError;
    }
    queueMicrotask(() => {
      if (this.settled) return;
      this.settled = true;
      if (succeeded) {
        this.onsuccess?.();
        this.tx.settle();
      } else {
        this.onerror?.();
        this.tx.fail(this.error as FakeError);
      }
    });
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: FakeError | null = null;
  private pendingRequests = 0;
  private finished = false;
  private readonly stores = new Map<string, FakeObjectStore>();
  readonly db: FakeDatabase;
  constructor(db: FakeDatabase, storeNames: readonly string[]) {
    this.db = db;
    for (const name of storeNames) {
      if (!db.data.has(name)) {
        throw new DOMException(`store ${name} not found`, "NotFoundError");
      }
      this.stores.set(name, new FakeObjectStore(this, name));
    }
  }
  objectStore(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (!store) {
      throw new DOMException(`store ${name} out of scope`, "NotFoundError");
    }
    return store;
  }
  register(): void {
    this.pendingRequests += 1;
  }
  settle(): void {
    this.pendingRequests -= 1;
    // Chained requests created inside an onsuccess callback register before
    // this decrement, so completion only fires after the whole chain lands.
    if (this.pendingRequests <= 0 && !this.finished) {
      this.finished = true;
      queueMicrotask(() => this.oncomplete?.());
    }
  }
  fail(err: FakeError): void {
    if (this.finished) return;
    this.finished = true;
    this.error = err;
    queueMicrotask(() => {
      this.onerror?.();
      this.onabort?.();
    });
  }
  abort(): void {
    /* tests never abort explicitly */
  }
}

class FakeObjectStore {
  private readonly tx: FakeTransaction;
  private readonly name: string;
  constructor(tx: FakeTransaction, name: string) {
    this.tx = tx;
    this.name = name;
  }
  private get data(): Map<string, unknown> {
    return this.tx.db.data.get(this.name) as Map<string, unknown>;
  }
  private keyFor(value: unknown, key: string | undefined): string {
    if (key !== undefined) return key;
    const record = value as { key?: unknown } | null;
    if (record && typeof record.key === "string") return record.key;
    throw new DOMException("DataError: no key for put", "DataError");
  }
  get(key: string): FakeRequest {
    const request = new FakeRequest(this.tx, () => this.data.get(key));
    request.execute();
    return request;
  }
  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest(this.tx, () => [...this.data.values()]);
    request.execute();
    return request;
  }
  put(value: unknown, key?: string): FakeRequest<string> {
    const resolvedKey = this.keyFor(value, key);
    const request = new FakeRequest(this.tx, () => {
      const failPut = this.tx.db.failPut;
      if (failPut) {
        const err = new Error(failPut.message) as Error & { name: string };
        err.name = failPut.name;
        throw err;
      }
      this.data.set(resolvedKey, value);
      return resolvedKey;
    });
    request.execute();
    return request;
  }
  delete(key: string): FakeRequest<undefined> {
    const request = new FakeRequest(this.tx, () => {
      this.data.delete(key);
      return undefined;
    });
    request.execute();
    return request;
  }
}

class FakeDatabase {
  readonly data: Map<string, Map<string, unknown>>;
  private readonly config: FakeDbConfig;
  constructor(config: FakeDbConfig) {
    this.config = config;
    this.data = new Map<string, Map<string, unknown>>([
      ["chunks", new Map<string, unknown>()],
      ["meta", new Map<string, unknown>()],
      ["sizes", new Map<string, unknown>()],
    ]);
  }
  get failPut(): FakeError | undefined {
    return this.config.failPut;
  }
  get objectStoreNames(): { contains: (name: string) => boolean } {
    return { contains: (name: string) => this.data.has(name) };
  }
  createObjectStore(name: string): void {
    if (!this.data.has(name)) this.data.set(name, new Map<string, unknown>());
  }
  transaction(storeNames: string | readonly string[]): FakeTransaction {
    const names =
      typeof storeNames === "string" ? [storeNames] : [...storeNames];
    return new FakeTransaction(this, names);
  }
  close(): void {}
}

class FakeOpenRequest {
  result: FakeDatabase | null = null;
  error: FakeError | null = null;
  onupgradeneeded: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  private readonly config: FakeDbConfig;
  constructor(config: FakeDbConfig) {
    this.config = config;
  }
  start(): void {
    queueMicrotask(() => {
      if (this.config.openError) {
        this.error = this.config.openError;
        queueMicrotask(() => this.onerror?.());
        return;
      }
      this.result = new FakeDatabase(this.config);
      queueMicrotask(() => {
        this.onupgradeneeded?.();
        queueMicrotask(() => this.onsuccess?.());
      });
    });
  }
}

function makeFakeIndexedDb(config: FakeDbConfig = {}) {
  return {
    open: () => {
      const request = new FakeOpenRequest(config);
      request.start();
      return request;
    },
  };
}

// ---- SW sandbox harness ---------------------------------------------------

type SwListener = (event: unknown) => void;

function makeSw(cap?: number) {
  const listeners = new Map<string, SwListener>();
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, handler: SwListener) => {
      listeners.set(type, handler);
    },
    skipWaiting: vi.fn(),
    clients: { matchAll: vi.fn(() => []), claim: vi.fn() },
  };
  if (cap !== undefined) fakeSelf.DRPLAY_BYTE_CACHE_CAP = cap;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- deliberate: runs the raw sw.js text in a sandboxed scope with a fake `self`
  new Function("self", swSource)(fakeSelf);
  return {
    emit: (type: string, event: unknown) => listeners.get(type)?.(event),
  };
}

async function roundtrip(
  sw: ReturnType<typeof makeSw>,
  fileId: string,
  range: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (range !== null) headers.Range = range;
  const request = new Request(
    `http://localhost/drive-stream/${fileId}?ext=mp3`,
    { headers },
  );
  const ev = { request, respondWith: vi.fn() };
  sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
  sw.emit("fetch", ev);
  return await (ev.respondWith.mock.calls[0]?.[0] as Promise<Response>);
}

// One macrotask drain: every fake-IDB / tee / stream continuation is
// microtask-scheduled, so a single setTimeout(0) flushes all pending writes.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function patternBody(size: number): string {
  let out = "";
  for (let i = 0; i < size; i++) out += String.fromCharCode(48 + (i % 10));
  return out;
}

// A 206 WITHOUT Content-Range, as Drive delivers through the CORS filter.
function corsFiltered(contentLength: number, body: string): Response {
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(contentLength),
    },
  });
}

function callsFor(fetchMock: ReturnType<typeof vi.fn>, fileId: string): number {
  // The SW rewrites /drive-stream/{id} to Drive's /files/{id}?alt=media.
  return fetchMock.mock.calls.filter(([input]) =>
    (input as Request).url.includes(`files/${fileId}?`),
  ).length;
}

// ---- Tests ----------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sw.js byte-range cache (IndexedDB) — Slice 1 contract", () => {
  it("contract 1: a fully covered range is served from IDB with zero Drive fetches", async () => {
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(corsFiltered(300, patternBody(300)));
    vi.stubGlobal("fetch", fetchMock);

    await roundtrip(sw, "abc", "bytes=0-"); // miss → Drive, learns total
    await flush(); // background write-through lands

    const cached = await roundtrip(sw, "abc", "bytes=0-299");
    expect(fetchMock).toHaveBeenCalledTimes(1); // RED if cache never serves
    expect(cached.status).toBe(206);
    expect(cached.headers.get("Content-Range")).toBe("bytes 0-299/300");
    expect(cached.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await cached.text()).toBe(patternBody(300));
  });

  it("contract 2: misses fetch Drive exactly as before (legacy headers + no-store); mid-chunk heads are discarded, not cached", async () => {
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(corsFiltered(262144, patternBody(262144)))
      .mockResolvedValue(corsFiltered(100, patternBody(100)));
    vi.stubGlobal("fetch", fetchMock);

    const warm = await roundtrip(sw, "abc", "bytes=0-"); // chunk0 full, learns total
    expect(warm.headers.get("Content-Range")).toBe("bytes 0-262143/262144");
    await flush();
    // Beyond chunk0 (chunk1 absent) → miss; the mock's 100-byte body starts
    // mid-chunk (head skip 100) and ends inside it → nothing storeable.
    const missed = await roundtrip(sw, "abc", "bytes=262244-262343");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(missed.status).toBe(206);
    expect(missed.headers.get("Content-Range")).toBeNull(); // end ≥ total → legacy untouched
    expect(missed.headers.get("Content-Type")).toBe("audio/mpeg");
    const driveRequest = fetchMock.mock.calls[1]?.[0] as Request;
    expect(driveRequest.cache).toBe("no-store"); // Chromium bug 1026876 guard
    expect(driveRequest.headers.get("Authorization")).toBe("Bearer tok");
    await flush();
    const again = await roundtrip(sw, "abc", "bytes=262244-262343");
    expect(fetchMock).toHaveBeenCalledTimes(3); // discarded head never fakes a hit
    expect(again.headers.get("Content-Range")).toBeNull();
  });

  it("contract 3: total size persists to IDB — seek still annotated after the in-memory LRU evicts", async () => {
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw();
    // contentLength 300000 vs a 300-byte body: exactly the partial-cache shape
    // (total learned + persisted; only chunk0's 300-byte prefix is stored).
    // Fresh Response per call: a real network never reuses a consumed body,
    // and tee() locks the shared mock object on the second call.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(corsFiltered(300000, patternBody(300)))
      .mockImplementation(() =>
        Promise.resolve(corsFiltered(100, patternBody(100))),
      );
    vi.stubGlobal("fetch", fetchMock);

    await roundtrip(sw, "abc", "bytes=0-"); // learns total 300000, persists it
    await flush();
    // Flood the 1000-entry in-memory LRU so 'abc' is evicted from the Map.
    for (let i = 0; i <= 1000; i++) {
      await roundtrip(sw, `f${String(i)}`, "bytes=0-");
    }
    await flush();

    const seek = await roundtrip(sw, "abc", "bytes=256000-256099");
    expect(callsFor(fetchMock, "abc")).toBe(2); // 1 warm-up + 1 seek (miss)
    expect(seek.status).toBe(206);
    // RED if the total was only in-memory: Content-Range would be null and
    // Chromium would refuse to decode this 206 (SRC_NOT_SUPPORTED).
    expect(seek.headers.get("Content-Range")).toBe(
      "bytes 256000-256099/300000",
    );
  });

  it("contract 4a: IDB open failure degrades to the legacy pass-through with a warn log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "indexedDB",
      makeFakeIndexedDb({
        openError: { name: "InvalidStateError", message: "db locked" },
      }),
    );
    const sw = makeSw();
    // Fresh Response per call — a real network never reuses a consumed body,
    // and tee() on a shared mock object locks/disturbs it on the second call.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(corsFiltered(300, patternBody(300))),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await roundtrip(sw, "abc", "bytes=0-");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-299/300");
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await response.text()).toBe(patternBody(300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush();
    expect(warnSpy).toHaveBeenCalled(); // classified warn, never silent

    const second = await roundtrip(sw, "abc", "bytes=0-299");
    expect(fetchMock).toHaveBeenCalledTimes(2); // nothing was cached
    expect(second.headers.get("Content-Range")).toBe("bytes 0-299/300");
  });

  it("contract 4b: QuotaExceededError on write keeps the response intact and logs a classified warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "indexedDB",
      makeFakeIndexedDb({
        failPut: { name: "QuotaExceededError", message: "quota exceeded" },
      }),
    );
    const sw = makeSw();
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(corsFiltered(300, patternBody(300))),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await roundtrip(sw, "abc", "bytes=0-");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await response.text()).toBe(patternBody(300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush();
    expect(warnSpy).toHaveBeenCalled();
    const write = await roundtrip(sw, "abc", "bytes=0-299");
    expect(fetchMock).toHaveBeenCalledTimes(2); // failed writes never fake a hit
    expect(await write.text()).toBe(patternBody(300));
  });

  it("contract 5: the byte cap evicts least-recently-accessed chunks first (named constant, test seam)", async () => {
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw(400); // 400-byte cap seam instead of 512MB
    // Fresh Response per call — tee() locks a shared mock body on call 2.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(corsFiltered(300, patternBody(300))),
      );
    vi.stubGlobal("fetch", fetchMock);

    await roundtrip(sw, "aaa", "bytes=0-"); // 300 bytes cached
    await flush();
    await roundtrip(sw, "bbb", "bytes=0-"); // 600 > 400 → evict 'aaa' (older LRU)
    await flush();

    const kept = await roundtrip(sw, "bbb", "bytes=0-299");
    expect(callsFor(fetchMock, "bbb")).toBe(1); // 'bbb' survived (newer access)
    expect(await kept.text()).toBe(patternBody(300));
    const evicted = await roundtrip(sw, "aaa", "bytes=0-299");
    expect(callsFor(fetchMock, "aaa")).toBe(2); // 'aaa' was evicted → refetch
    expect(await evicted.text()).toBe(patternBody(300));
  });

  it("contract 7: a shorter later write never shrinks a stored chunk prefix (extend-only merge)", async () => {
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw();
    // Fresh Response per call — tee() locks a shared mock body on call 2.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(corsFiltered(100, patternBody(100)))
      .mockImplementation(() =>
        Promise.resolve(corsFiltered(300, patternBody(300))),
      );
    vi.stubGlobal("fetch", fetchMock);

    const partial = await roundtrip(sw, "abc", "bytes=0-99"); // chunk0 prefix 100
    expect(partial.headers.get("Content-Range")).toBeNull(); // total unknown yet
    await flush();
    const full = await roundtrip(sw, "abc", "bytes=0-"); // miss → extend chunk0 to 300
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(full.headers.get("Content-Range")).toBe("bytes 0-299/300");
    await flush();
    const extended = await roundtrip(sw, "abc", "bytes=0-150");
    expect(fetchMock).toHaveBeenCalledTimes(2); // chunk0 kept the LONGER prefix
    expect(await extended.text()).toBe(patternBody(151));
    expect(extended.headers.get("Content-Range")).toBe("bytes 0-150/300");
  });
});
