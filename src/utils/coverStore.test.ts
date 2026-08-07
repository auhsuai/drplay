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
});
