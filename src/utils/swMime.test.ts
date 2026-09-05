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

  it("covers exactly the 6 playable extensions", () => {
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

// ---- sw.js source-encoding guard. The SW carries Vietnamese comments; a
// tool that re-reads them through a legacy code page (e.g. PowerShell 5.1
// Get-Content without -Encoding UTF8) displays them as "Ki?m tra..." mojibake
// and a "repair" through such a lens would CORRUPT the real UTF-8 bytes. The
// ?raw import serves the file's true bytes as UTF-8, so these asserts pin the
// intact state: any future edit that flattens the accents must fail here.
describe("sw.js source encoding health (Vietnamese comments intact)", () => {
  it("contains no U+FFFD replacement characters", () => {
    expect(swSource.includes(String.fromCharCode(0xfffd))).toBe(false);
  });

  it("keeps the known Vietnamese comment lines intact", () => {
    const intactLines = [
      "Bỏ qua trạng thái waiting, active ngay lập tức",
      "Claim các client hiện tại ngay lập tức để không cần reload trang",
      "Lắng nghe token từ App.tsx gửi sang",
      "Giữ nguyên các header gốc (đặc biệt là header Range: bytes=...)",
      "Kiểm tra xem đây có phải là request ảo để stream nhạc không",
      "Thực thi fetch trực tiếp lên Google Drive và trả về cho thẻ audio",
    ];
    for (const line of intactLines) {
      expect(swSource).toContain(line);
    }
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

// ---- Content-Range synthesis: Drive's CORS policy strips Content-Range from
// 206 responses (only Content-Disposition is exposed via
// Access-Control-Expose-Headers), which Chromium refuses to feed to <audio>
// (SRC_NOT_SUPPORTED, code=4). The SW must reconstruct the header from the
// request Range + response Content-Length. These mocks emulate the
// CORS-filtered response the sandboxed SW actually receives.

type RangeFetchEvent = {
  request: Request;
  respondWith: ReturnType<typeof vi.fn>;
};

// A 206 WITHOUT Content-Range, as Drive actually delivers through the CORS
// filter (the header is silently dropped server-side before the SW sees it).
function corsFilteredResponse(
  contentLength: number,
  body = "audio-bytes",
): Response {
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(contentLength),
    },
  });
}

function makeFetchEventWithRange(
  fileId: string,
  range: string | null,
): RangeFetchEvent {
  const headers: Record<string, string> = {};
  if (range !== null) headers.Range = range;
  const request = new Request(
    `http://localhost/drive-stream/${fileId}?ext=mp3`,
    {
      headers,
    },
  );
  return { request, respondWith: vi.fn() };
}

async function swResponse(ev: RangeFetchEvent): Promise<Response> {
  return (await ev.respondWith.mock.calls[0]?.[0]) as Response;
}

describe("sw.js Content-Range synthesis for CORS-stripped 206", () => {
  it("reconstructs Content-Range for an open-ended range (bytes=0-) and still overrides MIME", async () => {
    const sw = makeSw();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(corsFilteredResponse(291813658)),
    );
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    const ev = makeFetchEventWithRange("abc", "bytes=0-");
    sw.emit("fetch", ev);
    const response = await swResponse(ev);
    vi.unstubAllGlobals();
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      "bytes 0-291813657/291813658",
    );
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await response.text()).toBe("audio-bytes");
  });

  it("computes the total as start + Content-Length for an open-ended range (bytes=S-)", async () => {
    const sw = makeSw();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(corsFilteredResponse(139114778)),
    );
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    const ev = makeFetchEventWithRange("abc", "bytes=152698880-");
    sw.emit("fetch", ev);
    const response = await swResponse(ev);
    vi.unstubAllGlobals();
    expect(response.headers.get("Content-Range")).toBe(
      "bytes 152698880-291813657/291813658",
    );
  });

  it("passes a closed range through untouched when the total is unknown (metadata prefetch guard)", async () => {
    const sw = makeSw();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(corsFilteredResponse(131072)),
    );
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    const ev = makeFetchEventWithRange("abc", "bytes=0-131071");
    sw.emit("fetch", ev);
    const response = await swResponse(ev);
    vi.unstubAllGlobals();
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("annotates a closed range with the total cached from an earlier open-ended range (seek)", async () => {
    const sw = makeSw();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(corsFilteredResponse(291813658))
        .mockResolvedValue(corsFilteredResponse(4096)),
    );
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    const learnEv = makeFetchEventWithRange("abc", "bytes=0-");
    sw.emit("fetch", learnEv);
    const learnResponse = await swResponse(learnEv);
    expect(learnResponse.headers.get("Content-Range")).toBe(
      "bytes 0-291813657/291813658",
    );
    const seekEv = makeFetchEventWithRange("abc", "bytes=5000000-5004095");
    sw.emit("fetch", seekEv);
    const seekResponse = await swResponse(seekEv);
    vi.unstubAllGlobals();
    expect(seekResponse.headers.get("Content-Range")).toBe(
      "bytes 5000000-5004095/291813658",
    );
  });

  it("keeps an existing Content-Range untouched (no double synthesis)", async () => {
    const response = new Response("audio-bytes", {
      status: 206,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": "11",
        "Content-Range": "bytes 0-10/100",
      },
    });
    const sw = makeSw();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    const ev = makeFetchEventWithRange("abc", "bytes=0-");
    sw.emit("fetch", ev);
    const result = await swResponse(ev);
    vi.unstubAllGlobals();
    expect(result.headers.get("Content-Range")).toBe("bytes 0-10/100");
  });

  it("passes through when the request has no Range header", async () => {
    const sw = makeSw();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(corsFilteredResponse(100)),
    );
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    const ev = makeFetchEventWithRange("abc", null);
    sw.emit("fetch", ev);
    const response = await swResponse(ev);
    vi.unstubAllGlobals();
    expect(response.headers.get("Content-Range")).toBeNull();
  });

  it("evicts the oldest cached total beyond the cache limit", async () => {
    const sw = makeSw();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(corsFilteredResponse(10)));
    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    for (let i = 0; i <= 100; i++) {
      const ev = makeFetchEventWithRange(`f${String(i)}`, "bytes=0-");
      sw.emit("fetch", ev);
      await swResponse(ev);
    }
    const oldestEv = makeFetchEventWithRange("f0", "bytes=1-2");
    sw.emit("fetch", oldestEv);
    const oldest = await swResponse(oldestEv);
    expect(oldest.headers.get("Content-Range")).toBeNull();
    const newestEv = makeFetchEventWithRange("f100", "bytes=1-2");
    sw.emit("fetch", newestEv);
    const newest = await swResponse(newestEv);
    vi.unstubAllGlobals();
    expect(newest.headers.get("Content-Range")).toBe("bytes 1-2/10");
  });
});
