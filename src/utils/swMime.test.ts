import { describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";
import { AUDIO_EXTENSION_TO_MIME } from "./audioFormat";
import { PLAYABLE_AUDIO_EXTENSIONS } from "./audioQuery";

// public/sw.js cannot import TS modules, so it carries an independent copy of
// the extension->MIME map. This guard keeps the SW literal and the canonical
// TS map (audioFormat.ts) in sync by parsing the SW source text.
function extractExtensionToMime(source: string): Record<string, string> {
  const start = source.indexOf("const EXTENSION_TO_MIME = {");
  if (start === -1) return {};
  const end = source.indexOf("};", start);
  if (end === -1) return {};
  const block = source.slice(start, end);
  const map: Record<string, string> = {};
  for (const m of block.matchAll(/^\s*([a-z0-9]+):\s*'([^']+)',?$/gm)) {
    const key = m[1];
    if (key) map[key] = m[2] ?? "";
  }
  return map;
}

const SW_EXTENSION_TO_MIME = extractExtensionToMime(swSource);

function canonicalKeys(): string[] {
  return PLAYABLE_AUDIO_EXTENSIONS.map((e) => e.slice(1)).sort();
}

describe("sw.js EXTENSION_TO_MIME guard", () => {
  it("contains a parseable EXTENSION_TO_MIME map", () => {
    expect(Object.keys(SW_EXTENSION_TO_MIME).length).toBeGreaterThan(0);
  });

  it("covers exactly the 7 playable extensions", () => {
    expect(Object.keys(SW_EXTENSION_TO_MIME).sort()).toEqual(canonicalKeys());
  });

  it("maps each extension to the canonical MIME", () => {
    for (const [ext, mime] of Object.entries(AUDIO_EXTENSION_TO_MIME)) {
      expect(SW_EXTENSION_TO_MIME[ext]).toBe(mime);
    }
  });

  it("the canonical TS map is itself consistent with PLAYABLE_AUDIO_EXTENSIONS", () => {
    expect(Object.keys(AUDIO_EXTENSION_TO_MIME).sort()).toEqual(
      canonicalKeys(),
    );
  });
});

// ---- Behavioral tests: run the real sw.js in a sandbox (same pattern as
// src/hooks/swTokenRetry.test.ts) and assert the Content-Type override.
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
    makeFetchEvent: (fileId: string, query: string) => {
      const request = new Request(
        `http://localhost/drive-stream/${fileId}${query}`,
        { headers: { Range: "bytes=0-" } },
      );
      return { request, respondWith: vi.fn() };
    },
  };
}

function octetResponse(): Response {
  return new Response("audio-bytes", {
    status: 206,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": "11",
      "Content-Range": "bytes 0-10/100",
      "Accept-Ranges": "bytes",
    },
  });
}

async function fetchViaSw(urlQuery: string): Promise<Response> {
  const sw = makeSw();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(octetResponse()));
  sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
  const ev = sw.makeFetchEvent("abc", urlQuery);
  sw.emit("fetch", ev);
  const response = (await ev.respondWith.mock.calls[0]?.[0]) as Response;
  vi.unstubAllGlobals();
  return response;
}

describe("sw.js Content-Type override behavior", () => {
  it("?ext=flac overrides octet-stream to audio/flac and keeps status/Range headers + body", async () => {
    const response = await fetchViaSw("?ext=flac");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("audio/flac");
    // Range/seek headers must survive the Response rebuild untouched.
    expect(response.headers.get("Content-Range")).toBe("bytes 0-10/100");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe("11");
    expect(await response.text()).toBe("audio-bytes");
  });

  it("missing ext passes the response through unchanged (backward compat)", async () => {
    const response = await fetchViaSw("");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(await response.text()).toBe("audio-bytes");
  });

  it("a hostile ext (uppercase) is ignored — pass-through, no crash", async () => {
    const response = await fetchViaSw("?ext=MP3");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
  });

  it("a hostile ext (..) is ignored — pass-through, no crash", async () => {
    const response = await fetchViaSw("?ext=..");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
  });

  it("a 401 response is never overridden", async () => {
    const sw = makeSw();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 401 })),
    );
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    const ev = sw.makeFetchEvent("abc", "?ext=flac");
    sw.emit("fetch", ev);
    const response = (await ev.respondWith.mock.calls[0]?.[0]) as Response;
    vi.unstubAllGlobals();
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).not.toBe("audio/flac");
  });
});
