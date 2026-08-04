import { afterEach, describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

// Mirrors the SW-side timeout constant; must stay in sync with public/sw.js.
const SW_TOKEN_WAIT_TIMEOUT_MS = 10_000;
const SW_TOKEN_EXPIRED_MSG = { type: "SW_TOKEN_EXPIRED" };

type SwListener = (event: unknown) => void;

interface FakeSelf {
  emit: (type: string, event: unknown) => void;
  postMessage: ReturnType<typeof vi.fn>;
  makeFetchEvent: (fileId: string) => {
    request: Request;
    respondWith: ReturnType<typeof vi.fn>;
  };
}

function createFakeSelf(): FakeSelf {
  const listeners = new Map<string, SwListener>();
  const client = { postMessage: vi.fn() };

  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, handler: SwListener) => {
      listeners.set(type, handler);
    },
    skipWaiting: vi.fn(),
    clients: {
      matchAll: vi.fn(async () => [client]),
      claim: vi.fn(),
    },
  };

  // Execute the real SW source in a fresh scope per test (the ?raw import
  // returns the file text; `new Function` gives it a fake `self`).
  new Function("self", swSource)(fakeSelf);

  return {
    emit: (type: string, event: unknown) => listeners.get(type)?.(event),
    postMessage: client.postMessage,
    makeFetchEvent: (fileId: string) => {
      const request = new Request(`http://localhost/drive-stream/${fileId}`, {
        headers: { Range: "bytes=0-" },
      });
      return { request, respondWith: vi.fn() };
    },
  };
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sw.js /drive-stream/ 401 recovery", () => {
  it("notifies clients and retries exactly once with the fresh token after UPDATE_TOKEN", async () => {
    const sw = createFakeSelf();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(new Response("audio-bytes", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "old-token" } });
    const ev = sw.makeFetchEvent("abc");
    sw.emit("fetch", ev);

    await vi.waitFor(() =>
      expect(sw.postMessage).toHaveBeenCalledWith(SW_TOKEN_EXPIRED_MSG),
    );

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "new-token" } });

    const response = (await ev.respondWith.mock.calls[0][0]) as Response;
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryRequest = fetchMock.mock.calls[1][0] as Request;
    expect(retryRequest.headers.get("Authorization")).toBe("Bearer new-token");
    // Original headers (Range) must survive the retry rebuild.
    expect(retryRequest.headers.get("Range")).toBe("bytes=0-");
  });

  it("returns the original 401 when no real token change arrives before the timeout", async () => {
    vi.useFakeTimers();
    const sw = createFakeSelf();
    const fetchMock = vi.fn().mockResolvedValue(unauthorized());
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "old-token" } });
    const ev = sw.makeFetchEvent("abc");
    sw.emit("fetch", ev);

    await vi.advanceTimersByTimeAsync(0);
    expect(sw.postMessage).toHaveBeenCalledWith(SW_TOKEN_EXPIRED_MSG);

    // An UPDATE_TOKEN carrying the SAME token must not resolve the waiter.
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "old-token" } });

    const responsePromise = ev.respondWith.mock
      .calls[0][0] as Promise<Response>;
    await vi.advanceTimersByTimeAsync(SW_TOKEN_WAIT_TIMEOUT_MS);
    const response = await responsePromise;
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves two concurrent 401 waiters with a single UPDATE_TOKEN", async () => {
    const sw = createFakeSelf();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(new Response("audio-1", { status: 200 }))
      .mockResolvedValueOnce(new Response("audio-2", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "old-token" } });
    const ev1 = sw.makeFetchEvent("aaa");
    const ev2 = sw.makeFetchEvent("bbb");
    sw.emit("fetch", ev1);
    sw.emit("fetch", ev2);

    await vi.waitFor(() => expect(sw.postMessage).toHaveBeenCalledTimes(2));

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "new-token" } });

    const responses = await Promise.all([
      ev1.respondWith.mock.calls[0][0],
      ev2.respondWith.mock.calls[0][0],
    ]);
    expect(responses.map((r) => (r as Response).status)).toEqual([200, 200]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const authHeaders = fetchMock.mock.calls
      .slice(2)
      .map(([req]) => (req as Request).headers.get("Authorization"));
    expect(authHeaders).toEqual(["Bearer new-token", "Bearer new-token"]);
  });

  it("returns the original 401 when the retry is 401 too (no infinite loop)", async () => {
    const sw = createFakeSelf();
    const fetchMock = vi.fn().mockResolvedValue(unauthorized());
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "old-token" } });
    const ev = sw.makeFetchEvent("abc");
    sw.emit("fetch", ev);

    await vi.waitFor(() => expect(sw.postMessage).toHaveBeenCalled());
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "new-token" } });

    const response = (await ev.respondWith.mock.calls[0][0]) as Response;
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes non-401 responses through untouched (no client notification)", async () => {
    const sw = createFakeSelf();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("partial", { status: 206 }));
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "ok-token" } });
    const ev = sw.makeFetchEvent("abc");
    sw.emit("fetch", ev);

    const response = (await ev.respondWith.mock.calls[0][0]) as Response;
    expect(response.status).toBe(206);
    expect(sw.postMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the missing-token 401 short-circuit unchanged", async () => {
    const sw = createFakeSelf();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ev = sw.makeFetchEvent("abc");
    sw.emit("fetch", ev);

    const response = (await ev.respondWith.mock.calls[0][0]) as Response;
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sw.postMessage).not.toHaveBeenCalled();
  });
});
