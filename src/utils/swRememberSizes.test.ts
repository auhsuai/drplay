import { afterEach, describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

// Behavioral tests for the REMEMBER_TOTAL_SIZES message: the page seeds the
// SW's total-size cache from Drive listing metadata so the byte-cache serve
// gate works for files never streamed yet. Seeding is fill-miss only — a
// total learned from a real stream response (exact) must never be overwritten
// by the (possibly stale) listing size.

type SwListener = (event: unknown) => void;

function makeSw() {
  const listeners = new Map<string, SwListener>();
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, handler: SwListener) => {
      listeners.set(type, handler);
    },
    skipWaiting: vi.fn(),
    clients: { matchAll: vi.fn(() => []), claim: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- deliberate: runs the raw sw.js text in a sandboxed scope with a fake `self`
  new Function("self", swSource)(fakeSelf);
  return {
    emit: (type: string, event: unknown) => listeners.get(type)?.(event),
  };
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

function makeFetchEvent(fileId: string, range: string) {
  const request = new Request(
    `http://localhost/drive-stream/${fileId}?ext=mp3`,
    { headers: { Range: range } },
  );
  return { request, respondWith: vi.fn() };
}

async function roundtrip(
  sw: ReturnType<typeof makeSw>,
  fileId: string,
  range: string,
  body: string,
): Promise<Response> {
  const fetchMock = vi.fn().mockResolvedValue(corsFiltered(body.length, body));
  vi.stubGlobal("fetch", fetchMock);
  // Same wire order as the play path tests: the token must be pushed before
  // the fetch event, or the SW answers 401 without proxying to Drive.
  sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
  const ev = makeFetchEvent(fileId, range);
  sw.emit("fetch", ev);
  return (await ev.respondWith.mock.calls[0]?.[0]) as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sw.js REMEMBER_TOTAL_SIZES seeding", () => {
  it("seeds a missing total so a closed-range response gets Content-Range without any prior stream", async () => {
    const sw = makeSw();
    sw.emit("message", {
      data: {
        type: "REMEMBER_TOTAL_SIZES",
        entries: [{ fileId: "f1", size: 300 }],
      },
    });
    const response = await roundtrip(sw, "f1", "bytes=0-99", "a".repeat(100));
    expect(response.headers.get("Content-Range")).toBe("bytes 0-99/300");
  });

  it("never overwrites a total learned from a real stream (seed is fill-miss only)", async () => {
    const sw = makeSw();
    // Stream once with an open-ended range: the SW learns total = 300.
    const streamed = await roundtrip(sw, "f2", "bytes=0-", "b".repeat(300));
    expect(streamed.headers.get("Content-Range")).toBe("bytes 0-299/300");
    // Listing metadata says 999 — must be ignored.
    sw.emit("message", {
      data: {
        type: "REMEMBER_TOTAL_SIZES",
        entries: [{ fileId: "f2", size: 999 }],
      },
    });
    const response = await roundtrip(sw, "f2", "bytes=0-99", "c".repeat(100));
    expect(response.headers.get("Content-Range")).toBe("bytes 0-99/300");
  });

  it("skips invalid entries with a single warn; empty/non-array entries are silent no-ops", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sw = makeSw();
    expect(() =>
      sw.emit("message", {
        data: {
          type: "REMEMBER_TOTAL_SIZES",
          entries: [
            { fileId: "", size: 100 },
            { fileId: "f3", size: 0 },
            { fileId: "f3", size: 1.5 },
            { size: 100 },
            "junk",
          ],
        },
      }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Nothing seeded: a later closed-range request stays without Content-Range.
    const response = await roundtrip(sw, "f3", "bytes=0-99", "d".repeat(100));
    expect(response.headers.get("Content-Range")).toBeNull();
    // Empty array and non-array entries: silent no-op (no extra warn).
    sw.emit("message", {
      data: { type: "REMEMBER_TOTAL_SIZES", entries: [] },
    });
    sw.emit("message", { data: { type: "REMEMBER_TOTAL_SIZES" } });
    sw.emit("message", {
      data: { type: "REMEMBER_TOTAL_SIZES", entries: "junk" },
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
