import { afterEach, describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

// Behavioral tests for Slice 2's bounded retry/backoff on the play path:
// transient 429/5xx upstream responses are retried with short backoff, while
// other statuses (401 recovery has its own path) stay single-shot.

type SwListener = (event: unknown) => void;

function makeSw() {
  const listeners = new Map<string, SwListener>();
  const client = { postMessage: vi.fn() };
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, handler: SwListener) => {
      listeners.set(type, handler);
    },
    skipWaiting: vi.fn(),
    clients: { matchAll: vi.fn(() => [client]), claim: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- deliberate: runs the raw sw.js text in a sandboxed scope with a fake `self`
  new Function("self", swSource)(fakeSelf);
  return {
    emit: (type: string, event: unknown) => listeners.get(type)?.(event),
    postMessage: client.postMessage,
  };
}

function makeFetchEvent(fileId: string) {
  const request = new Request(
    `http://localhost/drive-stream/${fileId}?ext=mp3`,
    {
      headers: { Range: "bytes=0-" },
    },
  );
  return { request, respondWith: vi.fn() };
}

function upstream(status: number): Response {
  return new Response(`body-${String(status)}`, {
    status,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

async function roundtrip(
  sw: ReturnType<typeof makeSw>,
  fileId: string,
): Promise<Response> {
  const ev = makeFetchEvent(fileId);
  sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
  sw.emit("fetch", ev);
  return await (ev.respondWith.mock.calls[0]?.[0] as Promise<Response>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sw.js play-path retry/backoff for 429/5xx (Slice 2)", () => {
  it("retries a 500 after the first backoff delay and serves the recovery", async () => {
    vi.useFakeTimers();
    const sw = makeSw();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstream(500))
      .mockResolvedValueOnce(upstream(206));
    vi.stubGlobal("fetch", fetchMock);

    const ev = makeFetchEvent("abc");
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    sw.emit("fetch", ev);
    const pending = ev.respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await vi.advanceTimersByTimeAsync(400);
    const response = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("body-206");
  });

  it("retries a 429 (rate limit) once then succeeds", async () => {
    vi.useFakeTimers();
    const sw = makeSw();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstream(429))
      .mockResolvedValueOnce(upstream(206));
    vi.stubGlobal("fetch", fetchMock);

    const ev = makeFetchEvent("abc");
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    sw.emit("fetch", ev);
    const pending = ev.respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await vi.advanceTimersByTimeAsync(400);
    const response = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(206);
  });

  it("gives up after the bounded retries and returns the last 500", async () => {
    vi.useFakeTimers();
    const sw = makeSw();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(upstream(500)));
    vi.stubGlobal("fetch", fetchMock);

    const ev = makeFetchEvent("abc");
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    sw.emit("fetch", ev);
    const pending = ev.respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await vi.advanceTimersByTimeAsync(1600); // 400 + 1200
    const response = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 bounded retries
    expect(response.status).toBe(500);
  });

  it("does not retry non-transient 4xx (404 stays single-shot)", async () => {
    const sw = makeSw();
    const fetchMock = vi.fn().mockResolvedValue(upstream(404));
    vi.stubGlobal("fetch", fetchMock);

    const response = await roundtrip(sw, "abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
  });

  it("does not retry 401 on this path (token recovery handles it, exactly once)", async () => {
    const sw = makeSw();
    const fetchMock = vi.fn().mockResolvedValue(upstream(401));
    vi.stubGlobal("fetch", fetchMock);

    const ev = makeFetchEvent("abc");
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    sw.emit("fetch", ev);
    const pending = ev.respondWith.mock.calls[0]?.[0] as Promise<Response>;
    await vi.waitFor(() => {
      expect(sw.postMessage).toHaveBeenCalled();
    });
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok2" } });
    const response = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + single 401 retry
    expect(response.status).toBe(401);
  });
});
