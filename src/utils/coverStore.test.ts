import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCoverUrl, postCoverToCache } from "./coverStore";
import { captureError } from "./errorLog";

vi.mock("./errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedCaptureError = vi.mocked(captureError);

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response(null, { status });
}

describe("buildCoverUrl (GET /cover?id= contract from protocol/mod.rs)", () => {
  it("builds the GET route with thumb=true", () => {
    expect(buildCoverUrl("file_1", true)).toBe(
      "drplay://cover?id=file_1&thumb=true",
    );
  });

  it("builds the GET route with thumb=false", () => {
    expect(buildCoverUrl("file_1", false)).toBe(
      "drplay://cover?id=file_1&thumb=false",
    );
  });

  it("encodes the fileId (query value)", () => {
    expect(buildCoverUrl("a b&c/d", true)).toBe(
      "drplay://cover?id=a%20b%26c%2Fd&thumb=true",
    );
  });
});

describe("postCoverToCache (POST /cover/{id}?thumb= contract)", () => {
  beforeEach(() => {
    mockedCaptureError.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the raw bytes to drplay://cover/{id}?thumb= with a timeout signal", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await postCoverToCache("file_1", true, bytes);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as
      [RequestInfo | URL, RequestInit?] | undefined;
    expect(call?.[0]).toBe("drplay://cover/file_1?thumb=true");
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(bytes);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("uses thumb=false for the full variant POST", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await postCoverToCache("file_1", false, new Uint8Array([1]));

    const call = fetchMock.mock.calls[0] as
      [RequestInfo | URL, RequestInit?] | undefined;
    expect(call?.[0]).toBe("drplay://cover/file_1?thumb=false");
  });

  it("retries once on 5xx then logs a warn without throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(500))
      .mockResolvedValueOnce(statusResponse(500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postCoverToCache("retry-id", true, new Uint8Array([1])),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "coverStore",
        message: expect.stringContaining(
          "cover-post-failed",
        ) as unknown as string,
        kind: "CoverPostStatus",
      }),
    );
  });

  it("retries once on 429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await postCoverToCache("retry-id", true, new Uint8Array([1]));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("does NOT retry a 4xx client error (permanent, logs once)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(400)));
    vi.stubGlobal("fetch", fetchMock);

    await postCoverToCache("bad-id", true, new Uint8Array([1]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "CoverPostStatus" }),
    );
  });

  it("logs a warn when the request times out (AbortSignal.timeout fires)", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(
        new DOMException("The operation timed out", "TimeoutError"),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postCoverToCache("t-id", false, new Uint8Array([2])),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "TimeoutError" }),
    );
  });

  it("skips the POST entirely for an empty body", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await postCoverToCache("e-id", true, new Uint8Array(0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("never exceeds 3 concurrent POSTs (queue drains without overloading)", async () => {
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<Response>((resolve) => {
        resolvers.push(() => {
          active -= 1;
          resolve(okResponse());
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const posts = Array.from({ length: 6 }, (_, i) =>
      postCoverToCache(`id-${String(i)}`, true, new Uint8Array([1])),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);

    while (resolvers.length > 0) {
      const release = resolvers.shift();
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(posts);

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("dedupes concurrent identical POSTs (same id + variant already in flight)", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = postCoverToCache("dup-id", true, new Uint8Array([1, 2, 3]));
    await postCoverToCache("dup-id", true, new Uint8Array([1, 2, 3]));

    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (const resolve of resolvers.splice(0)) {
      resolve(okResponse());
    }
    await first;
  });

  // ORDER MATTERS from here on: the two tests below both flip the module-level
  // schemeUnavailable flag on the SHARED module instance, so they must stay at
  // the end of this file — any test declared after them would see the scheme
  // as permanently disabled and fail with 0 fetch calls.
  it("logs a warn and resolves on a network-level failure (no retry)", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postCoverToCache("net-id", true, new Uint8Array([1])),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "coverStore",
        message: expect.stringContaining(
          "cover-post-failed",
        ) as unknown as string,
      }),
    );
  });

  it("disables future POSTs after a scheme-dead failure (TypeError while the browser is online)", async () => {
    // The disable-once flag is module state, so this test imports a FRESH
    // module copy (cache cleared) — the shared instance may already be
    // disabled by the "network-level failure" test above.
    vi.resetModules();
    const { postCoverToCache: freshPost } = await import("./coverStore");
    const { captureError: freshCaptureError } = await import("./errorLog");
    const freshMockedCaptureError = vi.mocked(freshCaptureError);

    // Contract (audit B.1): ONLY a TypeError observed while ONLINE marks the
    // scheme dead forever. Pin onLine=true explicitly so this test keeps
    // asserting exactly that case regardless of the runtime's own navigator.
    vi.stubGlobal("navigator", { onLine: true });

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    // First POST: the network stack rejects (TypeError, ERR_UNKNOWN_URL_SCHEME)
    // and the failure is logged once, as before.
    await freshPost("blocked-1", true, new Uint8Array([1]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(freshMockedCaptureError).toHaveBeenCalledTimes(1);

    // Every later POST must be a no-op: no fetch, no warn noise.
    await freshPost("blocked-2", true, new Uint8Array([2]));
    await freshPost("blocked-2", false, new Uint8Array([3]));
    await freshPost("blocked-3", true, new Uint8Array([4]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(freshMockedCaptureError).toHaveBeenCalledTimes(1);
  });

  it("transient offline failure does not permanently disable uploads", async () => {
    // Fresh module copy: earlier tests latch schemeUnavailable on the SHARED
    // instance; the transient-offline contract needs an untouched copy.
    vi.resetModules();
    const { postCoverToCache: freshPost } = await import("./coverStore");
    const { captureError: freshCaptureError } = await import("./errorLog");
    const freshMockedCaptureError = vi.mocked(freshCaptureError);

    // Failure happens while the browser reports OFFLINE -> transient: warn +
    // drop as always, but the path must NOT latch off for the whole session.
    vi.stubGlobal("navigator", { onLine: false });
    const failingFetch = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    vi.stubGlobal("fetch", failingFetch);
    await expect(
      freshPost("offline-1", true, new Uint8Array([1])),
    ).resolves.toBeUndefined();
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(freshMockedCaptureError).toHaveBeenCalledTimes(1);

    // Connection back (onLine=true) -> the very next POST must retry for real.
    vi.stubGlobal("navigator", { onLine: true });
    const okFetch = vi.fn(() => Promise.resolve(okResponse()));
    vi.stubGlobal("fetch", okFetch);
    await freshPost("back-online", true, new Uint8Array([2]));

    expect(okFetch).toHaveBeenCalledTimes(1);
    expect(freshMockedCaptureError).toHaveBeenCalledTimes(1);
  });

  it("stays paused without fetching while still offline after a transient failure", async () => {
    vi.resetModules();
    const { postCoverToCache: freshPost } = await import("./coverStore");
    const { captureError: freshCaptureError } = await import("./errorLog");
    const freshMockedCaptureError = vi.mocked(freshCaptureError);

    vi.stubGlobal("navigator", { onLine: false });
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    vi.stubGlobal("fetch", fetchMock);

    await freshPost("offline-pause-1", true, new Uint8Array([1]));
    await freshPost("offline-pause-2", true, new Uint8Array([2]));

    // Still offline -> uploads stay paused: exactly one attempt total, no
    // per-track warn spam until connectivity returns.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(freshMockedCaptureError).toHaveBeenCalledTimes(1);
  });
});
