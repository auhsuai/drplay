import { afterEach, describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

// Behavioral tests for Slice 2's PREFETCH_TRACK message: the SW downloads the
// next track's open-ended range (same no-store + backoff proxy rules) and
// lands the bytes in the IDB byte-cache, so a later <audio> range request is
// served with zero Drive fetches.

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

function makeFetchEvent(fileId: string, range: string | null) {
  const headers: Record<string, string> = {};
  if (range !== null) headers.Range = range;
  const request = new Request(
    `http://localhost/drive-stream/${fileId}?ext=mp3`,
    { headers },
  );
  return { request, respondWith: vi.fn() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sw.js PREFETCH_TRACK → byte-cache warm-up (Slice 2)", () => {
  it("prefetch stores bytes; a later range request is served with zero Drive fetches", async () => {
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw();
    // Fresh Response per call — tee()/storeBodyChunks locks consumed bodies.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(corsFiltered(300, patternBody(300))),
      )
      .mockImplementation(() =>
        Promise.resolve(corsFiltered(300, patternBody(300))),
      );
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    sw.emit("message", {
      data: { type: "PREFETCH_TRACK", fileId: "abc" },
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The <audio> request for the same bytes must now be a pure cache hit.
    const ev = makeFetchEvent("abc", "bytes=0-299");
    sw.emit("fetch", ev);
    const response = (await ev.respondWith.mock.calls[0]?.[0]) as Response;
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // zero Drive fetches
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-299/300");
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await response.text()).toBe(patternBody(300));
  });

  it("prefetch learns the total size, enabling closed-range Content-Range on a later partial hit", async () => {
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw();
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(corsFiltered(300000, patternBody(300))),
      );
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    sw.emit("message", { data: { type: "PREFETCH_TRACK", fileId: "abc" } });
    await flush();

    const ev = makeFetchEvent("abc", "bytes=0-99");
    sw.emit("fetch", ev);
    const response = (await ev.respondWith.mock.calls[0]?.[0]) as Response;
    expect(response.headers.get("Content-Range")).toBe("bytes 0-99/300000");
    expect(await response.text()).toBe(patternBody(100));
  });

  it("prefetch with a non-ok upstream is a no-op with a warn log (no crash)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw();
    // 404 = single-shot (backoff for 429/5xx is covered in swStreamRetry.test.ts).
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("no", { status: 404 })),
      );
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    sw.emit("message", { data: { type: "PREFETCH_TRACK", fileId: "abc" } });
    await flush();
    expect(warnSpy).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Nothing cached → the later request still goes to Drive.
    const ev = makeFetchEvent("abc", "bytes=0-");
    sw.emit("fetch", ev);
    const response = (await ev.respondWith.mock.calls[0]?.[0]) as Response;
    expect(response.status).toBe(404);
  });

  it("prefetch without a token or fileId is ignored", async () => {
    vi.stubGlobal("indexedDB", makeFakeIndexedDb());
    const sw = makeSw();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // No token yet.
    sw.emit("message", { data: { type: "PREFETCH_TRACK", fileId: "abc" } });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    // Token present but no fileId.
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    sw.emit("message", { data: { type: "PREFETCH_TRACK" } });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Minimal fake IDB (same shape as swByteCache.test.ts).
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
    const resolvedKey = key ?? "implicit";
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
