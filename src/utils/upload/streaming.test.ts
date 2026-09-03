import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleChildFile, handleDiskFile } from "./streaming";
import { fetchWithAuth } from "../apiClient";
import {
  DEFAULT_READ_CHUNK_SIZE,
  openDiskReadStream,
  registerUploadPath,
  statDiskPath,
} from "../diskFs";
import type { DiskReadStream } from "../diskFs";
import { persistActiveSession } from "./session";
import { quotaAllows, tryGenerateClientId } from "./retry";
import { controllerFor } from "./controllers";
import { scheduleProgressNotify } from "./events";
import type { InternalEntry } from "./types";

// Real uploadFileResumableChunked + real readChunkFromState, with only the
// Tauri IPC (diskFs), the network (apiClient) and the manager plumbing mocked
// away: the sizeHint slicing, the 308-resume reopen/skip and the adaptive
// chunk levels are exercised through the exact production path.
vi.mock("../apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock("../errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("../diskFs", () => ({
  DEFAULT_READ_CHUNK_SIZE: 8 * 1024 * 1024,
  openDiskReadStream: vi.fn(),
  registerUploadPath: vi.fn(),
  statDiskPath: vi.fn(),
}));

vi.mock("./session", () => ({
  persistActiveSession: vi.fn(),
}));

vi.mock("./retry", () => ({
  quotaAllows: vi.fn(),
  tryGenerateClientId: vi.fn(),
}));

vi.mock("./controllers", () => ({
  controllerFor: vi.fn(),
}));

vi.mock("./events", () => ({
  scheduleProgressNotify: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchWithAuth);
const mockedOpenStream = vi.mocked(openDiskReadStream);
const mockedStat = vi.mocked(statDiskPath);
const mockedRegister = vi.mocked(registerUploadPath);
const mockedPersist = vi.mocked(persistActiveSession);
const mockedQuotaAllows = vi.mocked(quotaAllows);
const mockedTryGenerateClientId = vi.mocked(tryGenerateClientId);

const LOCATION =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=stream-123";

function makeLocationResponse(status: number, location: string): Response {
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "location" ? location : null,
    },
    json: () => ({}),
  } as unknown as Response;
}

function makeRangeResponse(status: number, range: string | null): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => (name.toLowerCase() === "range" ? range : null),
    },
    json: () => ({}),
  } as unknown as Response;
}

function makeJsonResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    headers: { get: () => null },
    json: () => body,
  } as unknown as Response;
}

// Deterministic non-repeating byte pattern so any misalignment (missing or
// duplicated bytes) breaks the byte-equality assertions.
function makeData(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

// Byte-exact comparison WITHOUT vitest's toEqual: toEqual on multi-MiB typed
// arrays is pathologically slow in vitest 4.1.10 (~46 s for an 8 MiB pair),
// which trips the 15 s test timeout on a passing assertion. O(n) element scan
// with a pinpointed {index, actual, expected} failure instead.
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  const len = actual.byteLength;
  for (let i = 0; i < len; i++) {
    if ((actual[i] ?? 0) !== (expected[i] ?? 0)) {
      expect({
        at: i,
        actual: actual[i] ?? 0,
        expected: expected[i] ?? 0,
      }).toEqual({
        at: 0,
        actual: 0,
        expected: 1,
      });
      return;
    }
  }
}

// Mirrors the tauri-plugin-fs stream: sequential reads of up to
// DEFAULT_READ_CHUNK_SIZE bytes, null at EOF, close releases the handle. A
// FRESH stream per open call (reopen semantics after a 308 resume).
function makeFakeStream(data: Uint8Array): DiskReadStream {
  let pos = 0;
  return {
    read(): Promise<Uint8Array | null> {
      if (pos >= data.length) return Promise.resolve(null);
      const end = Math.min(pos + DEFAULT_READ_CHUNK_SIZE, data.length);
      const out = data.slice(pos, end);
      pos = end;
      return Promise.resolve(out);
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const UPLOADED_FILE = {
  id: "file-9",
  name: "big.flac",
  mimeType: "audio/flac",
};

function makeEntry(path: string): InternalEntry {
  return {
    id: "entry-1",
    name: "big.flac",
    isFolder: false,
    parentId: "p",
    diskPath: path,
    status: "queued",
    token: "tok",
    kind: "diskFile",
  };
}

// Held-request fetch mock (same pattern as driveApi.test.ts): a call whose
// signal is already aborted rejects; otherwise the request stays pending
// until the test resolves it. Settled entries leave the queue, so the queue
// holds exactly the in-flight requests.
interface HeldRequest {
  signal: AbortSignal | null;
  aborted: boolean;
  resolve: (response: Response) => void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("aborted", "AbortError");
}

function holdFetch(): HeldRequest[] {
  const pending: HeldRequest[] = [];
  mockedFetch.mockImplementation((_url, opts) => {
    const signal = opts?.signal ?? null;
    if (signal instanceof AbortSignal && signal.aborted) {
      return Promise.reject(abortReason(signal));
    }
    return new Promise<Response>((resolve, reject) => {
      const entry: HeldRequest = { signal, aborted: false, resolve };
      pending.push(entry);
      const settle = () => {
        const idx = pending.indexOf(entry);
        if (idx !== -1) pending.splice(idx, 1);
      };
      entry.resolve = (r) => {
        settle();
        resolve(r);
      };
      if (signal instanceof AbortSignal) {
        signal.addEventListener(
          "abort",
          () => {
            entry.aborted = true;
            settle();
            reject(abortReason(signal));
          },
          { once: true },
        );
      }
    });
  });
  return pending;
}

function nextHeld(pending: HeldRequest[]): HeldRequest {
  const entry = pending[0];
  if (entry === undefined)
    throw new Error("expected an in-flight fetch, none held");
  return entry;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Test-controlled wall clock for the adaptive throughput measurement
// (performance.now is read before/after each chunk PUT).
function installElapsedClock(): { set: (ms: number) => void } {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    set: (ms: number) => {
      now = ms;
    },
  };
}

// Content-Range and body of the k-th PUT call (0-based, after the initiate).
function putAt(index: number): { range: string; body: Uint8Array } {
  const [, opts] = mockedFetch.mock.calls[index + 1] ?? [];
  const headers = opts?.headers as Record<string, string> | undefined;
  return {
    range: headers?.["Content-Range"] ?? "",
    body: opts?.body as Uint8Array,
  };
}

function statResult(size: number) {
  return {
    path: "C:\\Music\\big.flac",
    name: "big.flac",
    relativePath: "big.flac",
    isDirectory: false,
    size,
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockedOpenStream.mockReset();
  mockedStat.mockReset();
  mockedRegister.mockReset();
  mockedPersist.mockReset();
  mockedQuotaAllows.mockReset();
  mockedTryGenerateClientId.mockReset();
  vi.clearAllMocks();

  mockedRegister.mockResolvedValue(undefined);
  mockedPersist.mockResolvedValue(undefined);
  mockedQuotaAllows.mockResolvedValue(true);
  mockedTryGenerateClientId.mockResolvedValue(undefined);
  vi.mocked(controllerFor).mockReturnValue(undefined);
  vi.mocked(scheduleProgressNotify).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleDiskFile streaming reader (real readChunkFromState + real chunked uploader)", () => {
  it("fast link: 8 MiB disk chunks stream through untouched, bytes byte-exact", async () => {
    const data = makeData(10 * 1024 * 1024);
    mockedOpenStream.mockImplementation(() =>
      Promise.resolve(makeFakeStream(data)),
    );
    mockedStat.mockResolvedValue(statResult(data.length));
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-8388607"))
      .mockResolvedValueOnce(makeJsonResponse(201, UPLOADED_FILE));

    const result = await handleDiskFile(makeEntry("C:\\Music\\big.flac"));

    expect(result.id).toBe("file-9");
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    // First PUT: the full 8 MiB disk chunk; second PUT: the remaining 2 MiB.
    const put1 = putAt(0);
    expect(put1.range).toBe("bytes 0-8388607/10485760");
    expectSameBytes(put1.body, data.slice(0, 8 * 1024 * 1024));
    const put2 = putAt(1);
    expect(put2.range).toBe("bytes 8388608-10485759/10485760");
    expectSameBytes(put2.body, data.slice(8 * 1024 * 1024));
  });

  it("slow link: 8 MiB chunk measured at 80 s -> ONE-level step: the remaining 2 MiB tail is sent as a single 2 MiB PUT, no bytes lost", async () => {
    const data = makeData(10 * 1024 * 1024);
    mockedOpenStream.mockImplementation(() =>
      Promise.resolve(makeFakeStream(data)),
    );
    mockedStat.mockResolvedValue(statResult(data.length));
    const clock = installElapsedClock();
    const pending = holdFetch();
    try {
      const p = handleDiskFile(makeEntry("C:\\Music\\big.flac"));

      await tick();
      nextHeld(pending).resolve(makeLocationResponse(200, LOCATION));
      await tick();
      // First chunk (8 MiB) takes 80 s — past the 0.6·128 s budget -> the
      // level steps down ONE level (2 MiB) for the following read.
      clock.set(80_000);
      nextHeld(pending).resolve(makeRangeResponse(308, "bytes=0-8388607"));
      await tick();
      // The 2 MiB tail is measured at ~0 ms (clock not advanced) and stays
      // at 2 MiB — exactly ONE PUT covers the remainder.
      nextHeld(pending).resolve(makeJsonResponse(201, UPLOADED_FILE));

      await expect(p).resolves.toMatchObject({ id: "file-9" });
      expect(mockedFetch).toHaveBeenCalledTimes(3);
      const expected: Array<[string, number, number]> = [
        ["bytes 0-8388607/10485760", 0, 8388608],
        ["bytes 8388608-10485759/10485760", 8388608, 10485760],
      ];
      for (let k = 0; k < expected.length; k++) {
        const [range, start, end] = expected[k] ?? ["", 0, 0];
        const put = putAt(k);
        expect(put.range).toBe(range);
        expectSameBytes(put.body, data.slice(start, end));
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("308 resume mid-chunk after a step-down: reopened stream + straddle remainder + 2 MiB slicing, every PUT byte-exact", async () => {
    const data = makeData(20 * 1024 * 1024);
    mockedOpenStream.mockImplementation(() =>
      Promise.resolve(makeFakeStream(data)),
    );
    mockedStat.mockResolvedValue(statResult(data.length));
    const clock = installElapsedClock();
    const pending = holdFetch();
    try {
      const p = handleDiskFile(makeEntry("C:\\Music\\big.flac"));

      await tick();
      nextHeld(pending).resolve(makeLocationResponse(200, LOCATION));
      await tick();
      // The 8 MiB chunk took 80 s (slow) AND the server only kept 4 MiB of it
      // — the resume offset (4194304) sits mid-chunk, inside the stream the
      // reader already consumed. Step-down + reopen/skip + slicing all at once.
      clock.set(80_000);
      nextHeld(pending).resolve(makeRangeResponse(308, "bytes=0-4194303"));
      await tick();
      // 8 x 2 MiB chunks from 4194304 to 20971520; the last answers 201.
      for (let i = 1; i <= 8; i++) {
        const start = 4194304 + (i - 1) * 2 * 1024 * 1024;
        const end = start + 2 * 1024 * 1024 - 1;
        nextHeld(pending).resolve(
          end === data.length - 1
            ? makeJsonResponse(201, UPLOADED_FILE)
            : makeRangeResponse(308, `bytes=0-${String(end)}`),
        );
        await tick();
        const put = putAt(i);
        expect(put.range).toBe(
          `bytes ${String(start)}-${String(end)}/${String(data.length)}`,
        );
        expectSameBytes(put.body, data.slice(start, end + 1));
      }

      await expect(p).resolves.toMatchObject({ id: "file-9" });
      // initiate + 8 MiB chunk + 8 x 2 MiB chunks.
      expect(mockedFetch).toHaveBeenCalledTimes(10);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("very slow link: 8 MiB at 80 s -> 2 MiB at 20 s -> 512 KiB floor, every PUT byte-exact", async () => {
    const data = makeData(12 * 1024 * 1024);
    mockedOpenStream.mockImplementation(() =>
      Promise.resolve(makeFakeStream(data)),
    );
    mockedStat.mockResolvedValue(statResult(data.length));
    const clock = installElapsedClock();
    const pending = holdFetch();
    try {
      const p = handleDiskFile(makeEntry("C:\\Music\\big.flac"));

      await tick();
      nextHeld(pending).resolve(makeLocationResponse(200, LOCATION));
      await tick();
      // Chunk 0 (8 MiB) at 80 s: past 0.6·128 s -> one step down to 2 MiB.
      clock.set(80_000);
      nextHeld(pending).resolve(makeRangeResponse(308, "bytes=0-8388607"));
      await tick();
      // Chunk 1 (2 MiB) at 20 s: past 0.6·32 s -> one step down to 512 KiB.
      clock.set(100_000);
      nextHeld(pending).resolve(makeRangeResponse(308, "bytes=0-10485759"));
      await tick();
      // Chunks 2..5 (512 KiB) measure ~0 ms -> the floor holds.
      nextHeld(pending).resolve(makeRangeResponse(308, "bytes=0-11010047"));
      await tick();
      nextHeld(pending).resolve(makeRangeResponse(308, "bytes=0-11534335"));
      await tick();
      nextHeld(pending).resolve(makeRangeResponse(308, "bytes=0-12058623"));
      await tick();
      nextHeld(pending).resolve(makeJsonResponse(201, UPLOADED_FILE));

      await expect(p).resolves.toMatchObject({ id: "file-9" });
      expect(mockedFetch).toHaveBeenCalledTimes(7);
      const expected: Array<[string, number, number]> = [
        ["bytes 0-8388607/12582912", 0, 8388608],
        ["bytes 8388608-10485759/12582912", 8388608, 10485760],
        ["bytes 10485760-11010047/12582912", 10485760, 11010048],
        ["bytes 11010048-11534335/12582912", 11010048, 11534336],
        ["bytes 11534336-12058623/12582912", 11534336, 12058624],
        ["bytes 12058624-12582911/12582912", 12058624, 12582912],
      ];
      for (let k = 0; k < expected.length; k++) {
        const [range, start, end] = expected[k] ?? ["", 0, 0];
        const put = putAt(k);
        expect(put.range).toBe(range);
        expectSameBytes(put.body, data.slice(start, end));
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("handleChildFile fs scope registration", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedOpenStream.mockReset();
    mockedStat.mockReset();
    mockedRegister.mockReset();
    vi.clearAllMocks();

    mockedRegister.mockResolvedValue(undefined);
    mockedPersist.mockResolvedValue(undefined);
    mockedQuotaAllows.mockResolvedValue(true);
    mockedTryGenerateClientId.mockResolvedValue(undefined);
    vi.mocked(controllerFor).mockReturnValue(undefined);
    vi.mocked(scheduleProgressNotify).mockImplementation(() => {});
    mockedStat.mockResolvedValue(statResult(4096));
    mockedOpenStream.mockImplementation(() =>
      Promise.resolve(makeFakeStream(makeData(4096))),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeChildEntry(overrides: Partial<InternalEntry>): InternalEntry {
    return {
      ...makeEntry("C:\\Music\\Album\\song.mp3"),
      kind: "folderChildFile",
      relativeDir: "",
      batchMemo: new Map<string, string>([["", "folder-1"]]),
      ...overrides,
    };
  }

  it("resumed folderChildFile re-registers the fs scope (runtime scope dies with the old process)", async () => {
    // Resume path through the REAL chunked uploader: query-status answers 404
    // (dead session → fresh initiate), then initiate + final PUT succeed.
    mockedFetch
      .mockResolvedValueOnce(makeJsonResponse(404, {}))
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, UPLOADED_FILE));
    const entry = makeChildEntry({ resumeUri: "https://upload.uri/session" });

    await handleChildFile(entry);

    expect(mockedRegister).toHaveBeenCalledWith("C:\\Music\\Album\\song.mp3");
  });

  it("fresh folderChildFile does NOT re-register (the batch root's recursive allow_directory already covers it)", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, UPLOADED_FILE));
    const entry = makeChildEntry({});

    await handleChildFile(entry);

    expect(mockedRegister).not.toHaveBeenCalled();
  });
});

// B1c follow-up residual window: the stat-size persist at the top of
// uploadDiskFileStreaming is a FULL-ROW put — without re-passing the entry's
// inherited session URI it wipes `uploadUri` from the active row a few ms
// after processEntry's first snapshot. The 308-resume path never fires
// onSessionUpdate (see driveApi.test.ts "resume from persisted session"), so
// nothing ever writes it back: a mid-upload crash then loses the server-side
// session (up to 7 days of TTL left) and restarts the file from byte 0.
describe("resumed entry keeps its inherited uploadUri in the active row", () => {
  const RESUMED_URI =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=persisted-9";
  const RESUMED_GEN_ID = "gen-id-persisted-9";

  it("resumed 308 path: every active-row persist carries the inherited URI", async () => {
    const data = makeData(10 * 1024 * 1024);
    mockedOpenStream.mockImplementation(() =>
      Promise.resolve(makeFakeStream(data)),
    );
    mockedStat.mockResolvedValue(statResult(data.length));
    // Query-status on the inherited URI → 308 → tail PUT → 201: this path
    // NEVER grants a new session URI, so the row's uploadUri can only come
    // from the persists made inside streaming itself.
    mockedFetch
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-8388607"))
      .mockResolvedValueOnce(makeJsonResponse(201, UPLOADED_FILE));

    const result = await handleDiskFile({
      ...makeEntry("C:\\Music\\big.flac"),
      resumeUri: RESUMED_URI,
      resumeTotalSize: data.length,
    });

    expect(result.id).toBe("file-9");
    // Zero initiates: the first call is the query-status PUT on the
    // inherited URI, not a fresh session.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const [queryUrl, queryOpts] = mockedFetch.mock.calls[0] ?? [];
    expect(queryUrl).toBe(RESUMED_URI);
    expect(
      (queryOpts?.headers as Record<string, string>)["Content-Range"],
    ).toBe(`*/${String(data.length)}`);

    // THE CONTRACT: the stat-size full-row put must re-carry the inherited
    // URI — and since no new URI is ever granted on this path, EVERY persist
    // of this entry must keep it.
    expect(mockedPersist).toHaveBeenCalled();
    for (const [, extra] of mockedPersist.mock.calls) {
      expect(extra?.uploadUri).toBe(RESUMED_URI);
    }
  });

  it("resumed 308 path: stat-persist also carries clientGeneratedId", async () => {
    const data = makeData(10 * 1024 * 1024);
    mockedOpenStream.mockImplementation(() =>
      Promise.resolve(makeFakeStream(data)),
    );
    mockedStat.mockResolvedValue(statResult(data.length));
    // Same never-grants-a-new-URI path as above: query-status → 308 → tail
    // PUT → 201, so onSessionUpdate never fires and the stat-size persist is
    // the ONLY write that can keep the inherited pre-generated id in the row.
    mockedFetch
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-8388607"))
      .mockResolvedValueOnce(makeJsonResponse(201, UPLOADED_FILE));

    await handleDiskFile({
      ...makeEntry("C:\\Music\\big.flac"),
      resumeUri: RESUMED_URI,
      resumeTotalSize: data.length,
      resumeClientGeneratedId: RESUMED_GEN_ID,
    });

    // THE CONTRACT: the stat-size full-row put must re-carry the inherited
    // pre-generated id alongside the URI — a wiped clientGeneratedId never
    // comes back on this path, and a later retry after a lost response loses
    // its idempotent 409-resolve-DONE binding (duplicate-file risk).
    expect(mockedPersist).toHaveBeenCalled();
    for (const [, extra] of mockedPersist.mock.calls) {
      expect(extra?.clientGeneratedId).toBe(RESUMED_GEN_ID);
    }
  });

  it("fresh entry unchanged: the stat-size persist extras stay exactly { totalSize }", async () => {
    const data = makeData(4 * 1024 * 1024);
    mockedOpenStream.mockImplementation(() =>
      Promise.resolve(makeFakeStream(data)),
    );
    mockedStat.mockResolvedValue(statResult(data.length));
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, UPLOADED_FILE));

    await handleDiskFile(makeEntry("C:\\Music\\big.flac"));

    // First persist is the stat-size one (before any session exists); for a
    // fresh entry its extras must stay byte-identical to the old behavior.
    const [, extra] = mockedPersist.mock.calls[0] ?? [];
    expect(extra).toEqual({ totalSize: data.length });
  });
});
