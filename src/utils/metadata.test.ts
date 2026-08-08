import { expect, test, describe, it, vi, beforeEach, afterEach } from "vitest";
import type { CachedMetadata } from "./metadata";
import type { MetadataCacheRow } from "../db/db";

const { filesUpdate, postCoverToCacheMock } = vi.hoisted(() => ({
  filesUpdate: vi.fn(() => 1),
  postCoverToCacheMock: vi.fn(() => Promise.resolve()),
}));

// Records every DriveRangeTokenizer construction (with its budgetBytes) so the
// ID3v2 budget tests can assert how many tokenizers a parse used and whether a
// raised budget was applied.
const tokenizerConstructions = vi.hoisted(
  () => [] as Array<{ budgetBytes: number | undefined }>,
);

const memoryStore = new Map<string, MetadataCacheRow>();

vi.mock("./coverStore", () => ({
  postCoverToCache: postCoverToCacheMock,
}));

vi.mock("../db/db", () => ({
  db: {
    metadataCache: {
      get: (key: string) => Promise.resolve(memoryStore.get(key)),
      put: (row: MetadataCacheRow) => {
        memoryStore.set(row.key, row);
        return Promise.resolve();
      },
      delete: (key: string) => {
        memoryStore.delete(key);
        return Promise.resolve();
      },
    },
    files: {
      update: filesUpdate,
    },
  },
}));

vi.mock("./errorLog", () => ({
  captureError: vi.fn(() => undefined),
}));

vi.mock("./coverCompress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coverCompress")>();
  return { ...actual, compressCoverImage: vi.fn() };
});

vi.mock("./driveRangeTokenizer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./driveRangeTokenizer")>();
  return {
    ...actual,
    DriveRangeTokenizer: class extends actual.DriveRangeTokenizer {
      constructor(
        fileId: string,
        size: number,
        options?: { budgetBytes?: number; abortSignal?: AbortSignal },
      ) {
        super(fileId, size, options);
        tokenizerConstructions.push({ budgetBytes: options?.budgetBytes });
      }
    },
  };
});

vi.mock("music-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("music-metadata")>();
  return { ...actual, parseFromTokenizer: vi.fn(actual.parseFromTokenizer) };
});

import {
  metadataCache,
  cacheTrackMetadata,
  clearAllMetadataCache,
  V_PLACEHOLDER,
  TAG_BUDGET_MAX,
  FULL_PERSIST_MAX_BYTES,
} from "./metadata";
import { captureError } from "./errorLog";
import {
  compressCoverImage,
  InvalidImageError,
  FULL_MAX_SIZE,
} from "./coverCompress";

function makeEntry(): CachedMetadata {
  return {
    title: "t",
    artist: "a",
    duration: 1,
    durationEstimated: false,
    pictureData: new Uint8Array([1, 2, 3]),
    pictureDataFull: new Uint8Array([9, 9, 9, 9]),
    v: 9,
  };
}

function makeRealEntry(
  overrides: Partial<CachedMetadata> = {},
): CachedMetadata {
  return {
    title: "Real Title",
    artist: "Real Artist",
    album: "Real Album",
    duration: 60,
    durationEstimated: false,
    pictureData: null,
    pictureDataFull: null,
    v: 8,
    ...overrides,
  };
}

function putCacheRow(key: string, data: CachedMetadata, version = 2) {
  memoryStore.set(key, { key, entry: { version, data, ts: Date.now() } });
}

// ---- ID3v2.3 fixture (minimal MP3: ID3v2 tag + one valid MPEG frame + padding)
function syncsafe32(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

function id3Frame(id: string, text: string): number[] {
  const body = [0x00, ...Array.from(text, (c) => c.charCodeAt(0))];
  return [
    ...Array.from(id, (c) => c.charCodeAt(0)),
    (body.length >>> 24) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff,
    body.length & 0xff,
    0x00,
    0x00,
    ...body,
  ];
}

function buildMp3Fixture(
  title: string,
  artist: string,
  album: string,
): Uint8Array {
  const frames = [
    ...id3Frame("TIT2", title),
    ...id3Frame("TPE1", artist),
    ...id3Frame("TALB", album),
  ];
  const tag = [
    0x49,
    0x44,
    0x33, // 'ID3'
    0x03,
    0x00, // version 2.3
    0x00, // flags
    ...syncsafe32(frames.length),
    ...frames,
  ];
  // one valid MPEG1 Layer III frame (128kbps 44.1kHz): header + 413 zero bytes
  const mpegFrame = [0xff, 0xfb, 0x90, 0x00, ...new Array<number>(413).fill(0)];
  const out = new Uint8Array(2048);
  out.set(tag, 0);
  out.set(mpegFrame, tag.length);
  return out;
}

// ---- ID3v2.3 fixture with an embedded APIC picture (JPEG bytes)
function makeJpeg(length = 11): Uint8Array {
  const img = new Uint8Array(length);
  img[0] = 0xff;
  img[1] = 0xd8;
  img[length - 2] = 0xff;
  img[length - 1] = 0xd9;
  return img;
}

function apicFrame(imageBytes: Uint8Array): number[] {
  const mime = Array.from("image/jpeg", (c) => c.charCodeAt(0));
  const body = [0x00, ...mime, 0x00, 0x03, 0x00, ...Array.from(imageBytes)];
  return [
    ...Array.from("APIC", (c) => c.charCodeAt(0)),
    (body.length >>> 24) & 0xff,
    (body.length >>> 16) & 0xff,
    (body.length >>> 8) & 0xff,
    body.length & 0xff,
    0x00,
    0x00,
    ...body,
  ];
}

function buildMp3WithPicture(
  title: string,
  artist: string,
  album: string,
  imageBytes: Uint8Array,
): Uint8Array {
  const frames = [
    ...id3Frame("TIT2", title),
    ...id3Frame("TPE1", artist),
    ...id3Frame("TALB", album),
    ...apicFrame(imageBytes),
  ];
  const tag = [
    0x49,
    0x44,
    0x33,
    0x03,
    0x00,
    0x00,
    ...syncsafe32(frames.length),
    ...frames,
  ];
  const mpegFrame = [0xff, 0xfb, 0x90, 0x00, ...new Array<number>(413).fill(0)];
  const out = new Uint8Array(tag.length + mpegFrame.length);
  out.set(tag, 0);
  out.set(mpegFrame, tag.length);
  return out;
}

// MP3 whose ID3v2 tag body spans tagBodyLen bytes: small text/APIC frames up
// front plus ONE giant PRIV frame filling the rest. A zero-padded body would
// make music-metadata iterate ~tagBodyLen/10 zero frame headers (slow); the
// single PRIV frame keeps the parse O(frames) while still forcing the parser
// to read the whole declared tag body (one readToken) — the exact scenario
// that blows the 20MB tokenizer budget.
function buildHugeTagMp3(
  tagBodyLen: number,
  opts: { title: string; artist: string; album: string; image: Uint8Array },
): Uint8Array {
  const { title, artist, album, image } = opts;
  const textFrames = [
    ...id3Frame("TIT2", title),
    ...id3Frame("TPE1", artist),
    ...id3Frame("TALB", album),
    ...apicFrame(image),
  ];
  const privBodyLen = tagBodyLen - textFrames.length - 10; // minus the PRIV frame header
  const privFrame = [
    ...Array.from("PRIV", (c) => c.charCodeAt(0)),
    (privBodyLen >>> 24) & 0xff,
    (privBodyLen >>> 16) & 0xff,
    (privBodyLen >>> 8) & 0xff,
    privBodyLen & 0xff,
    0x00,
    0x00,
    ...Array.from("DrPlay", (c) => c.charCodeAt(0)),
    0x00,
    ...new Array<number>(Math.max(0, privBodyLen - 7)).fill(0xaa),
  ];
  const tag = [
    0x49,
    0x44,
    0x33, // 'ID3'
    0x03,
    0x00, // version 2.3
    0x00, // flags
    ...syncsafe32(tagBodyLen),
    ...textFrames,
    ...privFrame,
  ];
  const mpegFrame = [0xff, 0xfb, 0x90, 0x00, ...new Array<number>(413).fill(0)];
  const out = new Uint8Array(tag.length + mpegFrame.length);
  out.set(tag, 0);
  out.set(mpegFrame, tag.length);
  return out;
}

// MP3 whose ID3v2 header declares a tag body larger than the file itself
// (declaredTagBody), with the rest of the file zero-filled — used to exercise
// the TAG_BUDGET_MAX cap without materializing the declared tag size.
function buildSparseMp3(
  declaredTagBody: number,
  fileBytes: number,
): Uint8Array {
  const header = [
    0x49,
    0x44,
    0x33,
    0x03,
    0x00,
    0x00,
    ...syncsafe32(declaredTagBody),
  ];
  const out = new Uint8Array(fileBytes);
  out.set(header, 0);
  return out;
}

// ---- FLAC fixture: STREAMINFO + VORBIS_COMMENT + optional huge PICTURE block.
// VORBIS_COMMENT precedes PICTURE so text is parsed before the (potentially
// budget-blowing) cover read -- this is the format where the budget retry can
// genuinely salvage the text entry.
function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u64be(n: bigint): number[] {
  const out: number[] = [];
  for (let shift = 56; shift >= 0; shift -= 8) {
    out.push(Number((n >> BigInt(shift)) & 0xffn));
  }
  return out;
}

function flacStreamInfo(): number[] {
  const sampleRate = 44100;
  const channels = 2;
  const bps = 16;
  const totalSamples = 441000;
  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bps - 1) << 36n) |
    BigInt(totalSamples);
  // 2 (min blocksize) + 2 (max blocksize) + 3 (min framesize) + 3 (max framesize)
  // + 8 (sample rate/channels/bps/total samples) + 16 (md5) = 34 bytes
  return [
    4096,
    4096,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...u64be(packed),
    ...new Array<number>(16).fill(0x11),
  ];
}

function flacBlockHeader(last: boolean, type: number, len: number): number[] {
  return [
    (last ? 0x80 : 0) | type,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
  ];
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function vorbisComment(title: string, artist: string): number[] {
  // Vorbis comments are little-endian (VorbisDecoder reads UINT32_LE).
  const vendor = "DrPlay";
  const vendorPart = [
    ...u32le(vendor.length),
    ...Array.from(vendor, (c) => c.charCodeAt(0)),
  ];
  const comments = [`TITLE=${title}`, `ARTIST=${artist}`];
  const parts = comments.flatMap((c) => [
    ...u32le(c.length),
    ...Array.from(c, (ch) => ch.charCodeAt(0)),
  ]);
  return [...vendorPart, ...u32le(comments.length), ...parts];
}

function buildFlacWithPicture(
  title: string,
  artist: string,
  pictures: Uint8Array[],
): Uint8Array {
  const si = flacStreamInfo();
  const comment = vorbisComment(title, artist);
  const headerBytes = [
    ...Array.from("fLaC", (c) => c.charCodeAt(0)),
    ...flacBlockHeader(false, 0, si.length),
    ...si,
    ...flacBlockHeader(false, 4, comment.length),
    ...comment,
  ];
  let total = headerBytes.length;
  const picHeaders: number[][] = [];
  for (const imageBytes of pictures) {
    const picHeader = [
      ...u32be(3), // picture type: Cover (front)
      ...u32be(10), // mime length
      ...Array.from("image/jpeg", (c) => c.charCodeAt(0)),
      ...u32be(0), // description length
      ...u32be(2000),
      ...u32be(2000),
      ...u32be(24),
      ...u32be(0), // width, height, depth, colors
      ...u32be(imageBytes.length),
    ];
    picHeaders.push(picHeader);
    // block header (4) + picture payload (fixed 42 bytes) + raw image bytes
    total += 4 + picHeader.length + imageBytes.length;
  }
  if (pictures.length === 0) {
    total += flacBlockHeader(true, 7, 0).length;
  }
  const out = new Uint8Array(total);
  out.set(headerBytes, 0);
  let offset = headerBytes.length;
  for (let i = 0; i < pictures.length; i++) {
    const imageBytes = pictures[i];
    if (!imageBytes) continue;
    const picHeader = picHeaders[i] ?? [];
    const last = i === pictures.length - 1;
    // FLAC block length is 3 bytes (max 16MB per block) -- callers must keep
    // each picture block under that cap.
    out.set(
      flacBlockHeader(last, 6, picHeader.length + imageBytes.length),
      offset,
    );
    offset += 4;
    out.set(picHeader, offset);
    offset += picHeader.length;
    out.set(imageBytes, offset);
    offset += imageBytes.length;
  }
  if (pictures.length === 0) {
    out.set(flacBlockHeader(true, 7, 0), offset);
  }
  return out;
}

function fourCC(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

function mp4Box(type: string, payload: number[]): number[] {
  return [...u32be(8 + payload.length), ...fourCC(type), ...payload];
}

function mvhdPayload(): number[] {
  return [
    0x00,
    0x00,
    0x00,
    0x00, // version + flags
    0x00,
    0x00,
    0x00,
    0x00, // creation time
    0x00,
    0x00,
    0x00,
    0x00, // modification time
    ...u32be(60_000), // time scale
    ...u32be(400_000), // duration -> 400000/60000 = 6.666s
    ...new Array<number>(80).fill(0), // MvhdAtom v0 needs a 100-byte payload
  ];
}

function buildM4aFaststart(totalSize = 1052): Uint8Array {
  const ftyp = mp4Box("ftyp", [
    ...fourCC("isom"),
    0x00,
    0x00,
    0x02,
    0x00,
    ...fourCC("isom"),
  ]); // 8 + 12 = 20
  const moov = mp4Box("moov", mp4Box("mvhd", mvhdPayload())); // 8 + 108 = 116
  const mdatPayload = totalSize - ftyp.length - moov.length - 8;
  const mdat = mp4Box(
    "mdat",
    new Array<number>(Math.max(0, mdatPayload)).fill(0),
  );
  const out = new Uint8Array(ftyp.length + moov.length + mdat.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  out.set(mdat, ftyp.length + moov.length);
  return out;
}

// head: ftyp + huge mdat (extends past HEAD_BYTES); tail: moov box at the very end
function buildM4aNonFaststart(totalSize = 200_000): Uint8Array {
  const ftyp = mp4Box("ftyp", [
    ...fourCC("isom"),
    0x00,
    0x00,
    0x02,
    0x00,
    ...fourCC("isom"),
  ]); // 8 + 12 = 20
  const moov = mp4Box("moov", mp4Box("mvhd", mvhdPayload())); // 8 + 108 = 116
  const mdat = mp4Box(
    "mdat",
    new Array<number>(
      Math.max(0, totalSize - ftyp.length - moov.length - 4 - 8),
    ).fill(0),
  );
  const out = new Uint8Array(ftyp.length + mdat.length + moov.length + 4);
  out.set(ftyp, 0);
  out.set(mdat, ftyp.length);
  out.set(moov, ftyp.length + mdat.length);
  return out;
}

function urlName(url: RequestInfo | URL): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return "(Request)";
}

function makeFetchMock(
  fileBytes: Uint8Array,
  opts: { forceStatus?: number; reject?: boolean; virtualSize?: number } = {},
) {
  const calls: Array<{ url: string; range: string | null }> = [];
  const mock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("Range");
    calls.push({ url: urlName(url), range });
    if (opts.reject) throw new TypeError("Failed to fetch");
    if (opts.forceStatus !== undefined) {
      return {
        status: opts.forceStatus,
        ok: opts.forceStatus >= 200 && opts.forceStatus < 300,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      };
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? "");
    if (!m) throw new Error(`missing Range header: ${String(range)}`);
    const start = Number(m[1]);
    // virtualSize: the fixture only materializes the head but claims a larger
    // file; ranges beyond the fixture serve zero-filled bytes (like a real
    // Drive file whose body was never materialized in the test).
    const end = Math.min(
      Number(m[2]),
      (opts.virtualSize ?? fileBytes.length) - 1,
    );
    const sliceLen = Math.max(0, end - start + 1);
    const slice = new Uint8Array(sliceLen);
    const available = Math.max(0, fileBytes.length - start);
    const copyLen = Math.min(sliceLen, available);
    if (copyLen > 0) {
      slice.set(fileBytes.subarray(start, start + copyLen), 0);
    }
    return {
      status: 206,
      ok: true,
      // Copy only the requested slice -- slice.buffer would hand back the WHOLE
      // underlying ArrayBuffer (fine for small fixtures, fatal for the >20MB
      // budget fixture where the tokenizer must fetch chunk by chunk).
      arrayBuffer: () => Promise.resolve(slice.slice(0).buffer),
    };
  });
  vi.stubGlobal("fetch", mock);
  return { mock, calls };
}

beforeEach(async () => {
  memoryStore.clear();
  filesUpdate.mockClear();
  tokenizerConstructions.length = 0;
  vi.mocked(captureError).mockClear();
  clearAllMetadataCache();
  // Fix H: the Drive throttle breaker is module-level, and these tests share
  // ONE tokenizer module instance across describe blocks (fresh() is a cached
  // dynamic import) — failures from unrelated scenarios would otherwise
  // accumulate and trip the circuit mid-file (every later test would fail
  // fast into a v:9 placeholder). Importing here (not statically) resolves
  // the same registry instance the tests' fresh() imports use, even after
  // vi.resetModules() in the dedup describe.
  const { resetDriveCircuitBreakerForTests } =
    await import("./driveRangeTokenizer");
  resetDriveCircuitBreakerForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("cacheTrackMetadata does not persist pictureDataFull in RAM", () => {
  cacheTrackMetadata("fid1", makeEntry());
  expect(metadataCache["fid1"]?.pictureDataFull).toBeNull();
  expect(metadataCache["fid1"]?.pictureData).toBeDefined();
});

test("cacheTrackMetadata still returns full entry for immediate callers (cover repair)", () => {
  const ret = cacheTrackMetadata("fid2", makeEntry());
  expect(ret.pictureDataFull).not.toBeNull();
});

test("clearAllMetadataCache empties the in-memory cache", () => {
  cacheTrackMetadata("fid3", makeEntry());
  clearAllMetadataCache();
  expect(Object.keys(metadataCache).length).toBe(0);
});

describe("getTrackMetadata dedup + real fetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("deduplicates concurrent requests for the same fileId and fetches once", async () => {
    const fixture = buildMp3Fixture(
      "Dedup Title",
      "Dedup Artist",
      "Dedup Album",
    );
    const { mock, calls } = makeFetchMock(fixture);

    const { getTrackMetadata } = await import("./metadata");

    const p1 = getTrackMetadata(
      "dedup-test-id",
      "test-token",
      2048,
      "test.mp3",
    );
    const p2 = getTrackMetadata(
      "dedup-test-id",
      "test-token",
      2048,
      "test.mp3",
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(calls[0]?.url).toContain("/drive-stream/dedup-test-id");
    expect(r1.v).toBe(8);
    expect(r1.title).toBe("Dedup Title");
    expect(r1.artist).toBe("Dedup Artist");
    expect(r1.album).toBe("Dedup Album");
  });
});

describe("getTrackMetadata real metadata fetch", () => {
  const fresh = () => import("./metadata");

  it("cache-first: an IDB real entry is returned without any network call", async () => {
    putCacheRow("metadata_cached-id", makeRealEntry({ title: "From Cache" }));
    const { getTrackMetadata } = await fresh();
    const { mock } = makeFetchMock(buildMp3Fixture("X", "Y", "Z"));

    const r = await getTrackMetadata("cached-id", "tok", 2048, "cached.mp3");
    expect(r.title).toBe("From Cache");
    expect(r.v).toBe(8);
    expect(mock).not.toHaveBeenCalled();
  });

  it("cache-first: an in-memory entry is returned without any network call", async () => {
    const mod = await fresh();
    const { getTrackMetadata, cacheTrackMetadata: cacheMem } = mod;
    const { mock } = makeFetchMock(buildMp3Fixture("X", "Y", "Z"));
    cacheMem("mem-id", makeRealEntry({ title: "Mem Title" }));

    const r = await getTrackMetadata("mem-id", "tok", 2048, "mem.mp3");
    expect(r.title).toBe("Mem Title");
    expect(mock).not.toHaveBeenCalled();
  });

  it("successful MP3 parse returns a real v:8 entry and writes the IDB cache row", async () => {
    const fixture = buildMp3Fixture("Song Title", "Song Artist", "Song Album");
    makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("mp3-id", "tok", 2048, "song.mp3");
    expect(r.v).toBe(8);
    expect(r.title).toBe("Song Title");
    expect(r.artist).toBe("Song Artist");
    expect(r.album).toBe("Song Album");
    expect(r.durationEstimated).toBe(true);
    expect(r.pictureData).toBeNull();
    expect(r.pictureDataFull).toBeNull();

    const row = memoryStore.get("metadata_mp3-id");
    expect(row).toBeDefined();
    const data = row?.entry as { version: number; data: CachedMetadata };
    expect(data.version).toBe(2);
    expect(data.data.v).toBe(8);
    expect(data.data.title).toBe("Song Title");
  });

  it("network failure falls back to a v:9 placeholder and logs a warning", async () => {
    makeFetchMock(new Uint8Array(0), { reject: true });
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("fail-id", "tok", 2048, "fail.mp3");
    expect(r.v).toBe(V_PLACEHOLDER);
    expect(r.title).toBe("fail");
    expect(r.durationEstimated).toBe(true);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "metadata" }),
    );
  });

  it("non-206 response falls back to a v:9 placeholder", async () => {
    makeFetchMock(new Uint8Array(0), { forceStatus: 200 });
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("no206-id", "tok", 2048, "no206.mp3");
    expect(r.v).toBe(V_PLACEHOLDER);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn" }),
    );
  });

  it("unknown/garbage bytes fall back to a v:9 placeholder (parse failure)", async () => {
    makeFetchMock(new Uint8Array(512).fill(0xde));
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("garbage-id", "tok", 512, "garbage.mp3");
    expect(r.v).toBe(V_PLACEHOLDER);
  });

  it("m4a faststart (moov before mdat) is streamable and does not touch files", async () => {
    makeFetchMock(buildM4aFaststart());
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("m4a-fast-id", "tok", 1052, "fast.m4a");
    expect(r.v).toBe(8);
    expect(r.title).toBe("fast");
    expect(filesUpdate).not.toHaveBeenCalled();
  });

  it("m4a non-faststart (mdat before moov, moov at tail) is marked streamUnplayable", async () => {
    makeFetchMock(buildM4aNonFaststart(200_000));
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("m4a-slow-id", "tok", 200_000, "slow.m4a");
    expect(r.v).toBe(8);
    expect(r.title).toBe("slow");
    expect(filesUpdate).toHaveBeenCalledWith("m4a-slow-id", {
      metadata: { format: "m4a", streamUnplayable: true },
    });
  });

  it("unknown size (0) returns a placeholder without any fetch", async () => {
    const { getTrackMetadata } = await fresh();
    const { mock } = makeFetchMock(new Uint8Array(0));

    const r = await getTrackMetadata("no-size-id", "tok", 0, "nosize.mp3");
    expect(r.v).toBe(V_PLACEHOLDER);
    expect(r.title).toBe("nosize");
    expect(mock).not.toHaveBeenCalled();

    const r2 = await getTrackMetadata(
      "no-size-id2",
      "tok",
      undefined,
      "nosize2.mp3",
    );
    expect(r2.v).toBe(V_PLACEHOLDER);
    expect(mock).not.toHaveBeenCalled();
  });

  it("AAC (ADTS) returns a placeholder without fetching beyond the head", async () => {
    const head = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0x00, 0x00]);
    const { getTrackMetadata } = await fresh();
    const { mock } = makeFetchMock(head);

    const r = await getTrackMetadata("aac-id", "tok", 4096, "song.aac");
    expect(r.v).toBe(V_PLACEHOLDER);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(filesUpdate).not.toHaveBeenCalled();
  });

  it("AAC placeholder carries the known file size (regression: placeholder dropped size)", async () => {
    const head = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0x00, 0x00]);
    const { getTrackMetadata } = await fresh();
    makeFetchMock(head);

    const r = await getTrackMetadata("aac-size-id", "tok", 4096, "song.aac");
    expect(r.v).toBe(V_PLACEHOLDER);
    expect(r.size).toBe(4096);
  });

  it("network-failure placeholder carries the known file size", async () => {
    makeFetchMock(new Uint8Array(0), { reject: true });
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("fail-size-id", "tok", 2048, "fail.mp3");
    expect(r.v).toBe(V_PLACEHOLDER);
    expect(r.size).toBe(2048);
  });

  it("size-unknown placeholder carries NO size field (undefined, not 0)", async () => {
    const { getTrackMetadata } = await fresh();
    makeFetchMock(new Uint8Array(0));

    const r = await getTrackMetadata("no-size-id3", "tok", 0, "nosize3.mp3");
    expect(r.v).toBe(V_PLACEHOLDER);
    expect(r.size).toBeUndefined();
  });

  it("forceNetwork bypasses the memory cache and re-fetches", async () => {
    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3Fixture("Forced Title", "Forced Artist", "Forced Album"),
    );
    cacheTrackMetadata("force-id", makeRealEntry({ title: "Stale" }));

    const r = await getTrackMetadata(
      "force-id",
      "tok",
      2048,
      "force.mp3",
      undefined,
      true,
    );
    expect(r.title).toBe("Forced Title");
    expect(r.v).toBe(8);
  });

  it("MP3 without ID3v2 tags falls back to filename title and Unknown Artist", async () => {
    const noTags = new Uint8Array(2048);
    noTags.set([0xff, 0xfb, 0x90, 0x00, ...new Array<number>(413).fill(0)], 0);
    makeFetchMock(noTags);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("untagged-id", "tok", 2048, "My Song.mp3");
    expect(r.title).toBe("My Song");
    expect(r.artist).toBe("Unknown Artist");
    expect(r.v).toBe(8);
  });
});

describe("getTrackMetadata head fetch + transient network failures", () => {
  const fresh = () => import("./metadata");

  beforeEach(() => {
    vi.mocked(compressCoverImage).mockReset();
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data:
          maxSize >= FULL_MAX_SIZE
            ? new Uint8Array([9, 8, 7])
            : new Uint8Array([1, 2, 3]),
        format: "image/jpeg",
        keptOriginal: false,
      }),
    );
  });

  it("fetches the 128KB head in a single range request (large file)", async () => {
    // 140KB ID3v2 tag body -> file > HEAD_BYTES: the head read must NOT be
    // split into two 64KB chunk fetches (one request for bytes=0-131071).
    const fixture = buildHugeTagMp3(140 * 1024, {
      title: "Head Song",
      artist: "Head Artist",
      album: "Head Album",
      image: makeJpeg(),
    });
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "head-1",
      "tok",
      fixture.length,
      "head.mp3",
    );
    expect(r.v).toBe(8);
    expect(calls[0]?.range).toBe("bytes=0-131071");
    // prefetch head (1) + the chunk past the head the tag-body parse needs (1)
    expect(calls).toHaveLength(2);
  });

  it("recovers from a transient timeout on the head request and parses", async () => {
    const fixture = buildMp3Fixture(
      "Retry Title",
      "Retry Artist",
      "Retry Album",
    );
    const mock = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("The operation timed out", "TimeoutError"),
      )
      .mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const range = headers.get("Range");
        const m = /bytes=(\d+)-(\d+)/.exec(range ?? "");
        if (!m) throw new Error(`missing Range header: ${String(range)}`);
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), fixture.length - 1);
        const slice = fixture.subarray(start, end + 1);
        return {
          status: 206,
          ok: true,
          arrayBuffer: () => Promise.resolve(slice.slice(0).buffer),
        };
      });
    vi.stubGlobal("fetch", mock);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata("retry-1", "tok", 2048, "retry.mp3");
    expect(r.v).toBe(8);
    expect(r.title).toBe("Retry Title");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not lock the placeholder after a transient network failure (next call refetches)", async () => {
    const { getTrackMetadata } = await fresh();
    // First call: network failure -> placeholder is returned (v:9) but must
    // NOT be pinned into the memory cache.
    makeFetchMock(new Uint8Array(0), { reject: true });
    const r1 = await getTrackMetadata("net-fail", "tok", 2048, "nf.mp3");
    expect(r1.v).toBe(V_PLACEHOLDER);

    // Second call (refresh / re-render): mock now serves a real file -> the
    // fetch MUST run again and return real metadata, not the stuck placeholder.
    const fixture = buildMp3Fixture(
      "Recovered",
      "Recovered Artist",
      "Recovered Album",
    );
    const { mock } = makeFetchMock(fixture);
    const r2 = await getTrackMetadata("net-fail", "tok", 2048, "nf.mp3");
    expect(r2.v).toBe(8);
    expect(r2.title).toBe("Recovered");
    expect(mock).toHaveBeenCalled();
  });
});

describe("cover extraction + full picture LRU", () => {
  const fresh = () => import("./metadata");

  function mockCompress(thumbBytes: Uint8Array, fullBytes: Uint8Array) {
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data: maxSize >= FULL_MAX_SIZE ? fullBytes : thumbBytes,
        format: "image/jpeg",
        keptOriginal: false,
      }),
    );
  }

  beforeEach(() => {
    vi.mocked(compressCoverImage).mockReset();
    mockCompress(new Uint8Array([1, 2, 3]), new Uint8Array([9, 8, 7]));
  });

  it("stores the compressed thumb + format and persists a small JPEG full variant to IDB", async () => {
    const mod = await fresh();
    const { getTrackMetadata, metadataCache: memCache } = mod;
    makeFetchMock(
      buildMp3WithPicture("Pic Song", "Pic Artist", "Pic Album", makeJpeg()),
    );

    const r = await getTrackMetadata("pic-a", "tok", 2048, "pic.mp3");
    expect(r.v).toBe(8);
    expect(r.title).toBe("Pic Song");
    expect(r.pictureData).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.pictureFormat).toBe("image/jpeg");
    expect(r.pictureDataFull).toEqual(new Uint8Array([9, 8, 7]));

    const row = memoryStore.get("metadata_pic-a");
    const stored = row?.entry as { data: CachedMetadata } | undefined;
    expect(stored?.data.pictureData?.byteLength ?? 0).toBeGreaterThan(0);
    // JPEG full ≤ FULL_PERSIST_MAX_BYTES → persisted for post-restart sharpness.
    expect(stored?.data.pictureDataFull).toEqual(new Uint8Array([9, 8, 7]));
    // The memory cache never holds full bytes (the LRU is the single owner).
    expect(memCache["pic-a"]?.pictureDataFull).toBeNull();
  });

  it("serves the full picture from the in-memory LRU after parse", async () => {
    const mod = await fresh();
    const { getTrackMetadata, getFullPictureData } = mod;
    makeFetchMock(
      buildMp3WithPicture("Pic Song", "Pic Artist", "Pic Album", makeJpeg()),
    );

    await getTrackMetadata("pic-b", "tok", 2048, "pic.mp3");
    expect(getFullPictureData("pic-b")).toEqual(new Uint8Array([9, 8, 7]));
    expect(getFullPictureData("missing-id")).toBeNull();
  });

  it("cache-first mem hit: pictureData from memory, pictureDataFull merged from LRU, no new fetch", async () => {
    const mod = await fresh();
    const { getTrackMetadata, getFullPictureData } = mod;
    const { mock, calls } = makeFetchMock(
      buildMp3WithPicture("Pic Song", "Pic Artist", "Pic Album", makeJpeg()),
    );

    await getTrackMetadata("pic-c", "tok", 2048, "pic.mp3");
    const fetchCountAfterParse = calls.length;

    const second = await getTrackMetadata("pic-c", "tok", 2048, "pic.mp3");
    expect(mock).toHaveBeenCalledTimes(fetchCountAfterParse);
    expect(second.pictureData).toEqual(new Uint8Array([1, 2, 3]));
    expect(second.pictureDataFull).toEqual(new Uint8Array([9, 8, 7]));
    expect(getFullPictureData("pic-c")).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("keeps a full variant larger than FULL_PERSIST_MAX_BYTES out of IDB (LRU still serves it)", async () => {
    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3WithPicture(
        "Big Full",
        "Big Full Artist",
        "Big Full Album",
        makeJpeg(),
      ),
    );
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data:
          maxSize >= FULL_MAX_SIZE
            ? new Uint8Array(FULL_PERSIST_MAX_BYTES + 1)
            : new Uint8Array([1, 2, 3]),
        format: "image/jpeg",
        keptOriginal: false,
      }),
    );

    const r = await getTrackMetadata("pic-bigfull", "tok", 2048, "pic.mp3");
    const row = memoryStore.get("metadata_pic-bigfull");
    const stored = row?.entry as { data: CachedMetadata } | undefined;
    // Memory still serves the full bytes this session...
    expect(r.pictureDataFull?.byteLength).toBe(FULL_PERSIST_MAX_BYTES + 1);
    // ...but IDB refuses to persist the oversized variant.
    expect(stored?.data.pictureDataFull).toBeNull();
    expect(stored?.data.pictureDataFull?.byteLength).toBeUndefined();
  });

  it("keeps a non-JPEG full variant out of IDB (PNG original kept, memory LRU unaffected)", async () => {
    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3WithPicture("PNG Pic", "PNG Artist", "PNG Album", makeJpeg()),
    );
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data:
          maxSize >= FULL_MAX_SIZE
            ? new Uint8Array([9, 8, 7])
            : new Uint8Array([1, 2, 3]),
        format: "image/png",
        keptOriginal: true,
      }),
    );

    const r = await getTrackMetadata("pic-png", "tok", 2048, "pic.mp3");
    const row = memoryStore.get("metadata_pic-png");
    const stored = row?.entry as { data: CachedMetadata } | undefined;
    expect(r.pictureDataFull).toEqual(new Uint8Array([9, 8, 7]));
    expect(stored?.data.pictureFormat).toBe("image/png");
    expect(stored?.data.pictureDataFull).toBeNull();
  });

  it("IDB hit with a persisted full variant seeds the memory LRU and returns the merged full", async () => {
    const fullBytes = new Uint8Array([7, 6, 5, 4]);
    putCacheRow(
      "metadata_pic-idb-seed",
      makeRealEntry({
        pictureData: new Uint8Array([1, 2, 3]),
        pictureDataFull: fullBytes,
        pictureFormat: "image/jpeg",
      }),
    );
    const mod = await fresh();
    const {
      getTrackMetadata,
      getFullPictureData,
      metadataCache: memCache,
    } = mod;
    const { mock } = makeFetchMock(buildMp3Fixture("X", "Y", "Z"));

    const r = await getTrackMetadata("pic-idb-seed", "tok", 2048, "pic.mp3");
    expect(mock).not.toHaveBeenCalled();
    // Full bytes are re-attached via the seeded LRU, so restart is sharp.
    expect(r.pictureDataFull).toEqual(fullBytes);
    expect(getFullPictureData("pic-idb-seed")).toEqual(fullBytes);
    // The mem entry itself stays full-free (LRU is the single owner).
    expect(memCache["pic-idb-seed"]?.pictureDataFull).toBeNull();
  });

  it("skips a picture larger than COVER_MAX_BYTES with a warning but keeps the v:8 text entry", async () => {
    const mm = await import("music-metadata");
    const parseSpy = mm.parseFromTokenizer as unknown as {
      mockImplementationOnce: (fn: () => Promise<unknown>) => void;
    };
    parseSpy.mockImplementationOnce(() =>
      Promise.resolve({
        common: {
          title: "Huge Title",
          artist: "Huge Artist",
          album: "Huge Album",
          picture: [
            { data: new Uint8Array(51 * 1024 * 1024), format: "image/jpeg" },
          ],
        },
        format: { duration: 60 },
      }),
    );
    const { getTrackMetadata } = await fresh();
    makeFetchMock(buildMp3Fixture("X", "Y", "Z"));

    const r = await getTrackMetadata("pic-d", "tok", 2048, "pic.mp3");
    expect(r.v).toBe(8);
    expect(r.title).toBe("Huge Title");
    expect(r.pictureData).toBeNull();
    expect(r.pictureDataFull).toBeNull();
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "cover-skip-too-large",
        ) as unknown as string,
      }),
    );
    expect(compressCoverImage).not.toHaveBeenCalled();
  });

  it("skips a truncated picture with a warning but keeps the v:8 text entry", async () => {
    const { getTrackMetadata } = await fresh();
    const truncated = makeJpeg();
    truncated[truncated.length - 2] = 0x00;
    makeFetchMock(
      buildMp3WithPicture(
        "Trunc Song",
        "Trunc Artist",
        "Trunc Album",
        truncated,
      ),
    );

    const r = await getTrackMetadata("pic-e", "tok", 2048, "pic.mp3");
    expect(r.v).toBe(8);
    expect(r.title).toBe("Trunc Song");
    expect(r.pictureData).toBeNull();
    expect(r.pictureDataFull).toBeNull();
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "cover-skip-truncated",
        ) as unknown as string,
      }),
    );
    expect(compressCoverImage).not.toHaveBeenCalled();
  });

  it("decode failure keeps the v:8 text entry and still stores the full variant", async () => {
    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3WithPicture("Fail Song", "Fail Artist", "Fail Album", makeJpeg()),
    );
    vi.mocked(compressCoverImage).mockRejectedValueOnce(
      new InvalidImageError("decode boom"),
    );

    const r = await getTrackMetadata("pic-f", "tok", 2048, "pic.mp3");
    expect(r.v).toBe(8);
    expect(r.title).toBe("Fail Song");
    expect(r.pictureData).toBeNull();
    expect(r.pictureDataFull).toEqual(new Uint8Array([9, 8, 7]));
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        kind: "InvalidImageError",
        message: expect.stringContaining(
          "cover-compress-failed",
        ) as unknown as string,
      }),
    );
  });

  it("salvages the v:8 text entry when the cover read blows the range budget", async () => {
    const { getTrackMetadata } = await fresh();
    // Two valid <16MB FLAC picture blocks whose combined reads (24MB) exceed
    // the 20MB tokenizer budget mid-way through the second block.
    const fixture = buildFlacWithPicture("Budget FLAC", "Budget Artist", [
      makeJpeg(12 * 1024 * 1024),
      makeJpeg(12 * 1024 * 1024),
    ]);
    makeFetchMock(fixture);

    const r = await getTrackMetadata(
      "pic-g",
      "tok",
      fixture.length,
      "pic.flac",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Budget FLAC");
    expect(r.artist).toBe("Budget Artist");
    expect(r.pictureData).toBeNull();
    expect(r.pictureDataFull).toBeNull();
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "cover-budget-exceeded",
        ) as unknown as string,
      }),
    );
    expect(compressCoverImage).not.toHaveBeenCalled();
  });

  it("evicts the oldest full picture when the entry cap (64) is exceeded", async () => {
    const mod = await fresh();
    const { getTrackMetadata, getFullPictureData } = mod;
    makeFetchMock(
      buildMp3WithPicture(
        "Evict Song",
        "Evict Artist",
        "Evict Album",
        makeJpeg(),
      ),
    );
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data:
          maxSize >= FULL_MAX_SIZE
            ? new Uint8Array(1024)
            : new Uint8Array([1, 2, 3]),
        format: "image/jpeg",
        keptOriginal: false,
      }),
    );

    for (let i = 0; i < 65; i++) {
      await getTrackMetadata(`ev-e${String(i)}`, "tok", 2048, "ev.mp3");
    }

    expect(getFullPictureData("ev-e0")).toBeNull();
    expect(getFullPictureData("ev-e64")).not.toBeNull();
    let resident = 0;
    for (let i = 0; i < 65; i++) {
      if (getFullPictureData(`ev-e${String(i)}`) !== null) resident++;
    }
    expect(resident).toBe(64);
  });

  it("evicts the oldest full picture when the byte cap (16MB) is exceeded", async () => {
    const mod = await fresh();
    const { getTrackMetadata, getFullPictureData } = mod;
    makeFetchMock(
      buildMp3WithPicture(
        "Evict Song",
        "Evict Artist",
        "Evict Album",
        makeJpeg(),
      ),
    );
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data:
          maxSize >= FULL_MAX_SIZE
            ? new Uint8Array(300 * 1024)
            : new Uint8Array([1, 2, 3]),
        format: "image/jpeg",
        keptOriginal: false,
      }),
    );

    for (let i = 0; i < 55; i++) {
      await getTrackMetadata(`ev-b${String(i)}`, "tok", 2048, "ev.mp3");
    }

    expect(getFullPictureData("ev-b0")).toBeNull();
    expect(getFullPictureData("ev-b1")).not.toBeNull();
    expect(getFullPictureData("ev-b54")).not.toBeNull();
  });

  it("FLAC without a picture block yields a v:8 entry with null picture fields", async () => {
    const { getTrackMetadata } = await fresh();
    const fixture = buildFlacWithPicture("Plain FLAC", "Plain Artist", []);
    makeFetchMock(fixture);

    const r = await getTrackMetadata(
      "pic-i",
      "tok",
      fixture.length,
      "pic.flac",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Plain FLAC");
    expect(r.pictureData).toBeNull();
    expect(r.pictureDataFull).toBeNull();
    expect(compressCoverImage).not.toHaveBeenCalled();
  });

  it("MP3 with a 25MB ID3v2 tag parses with a raised tokenizer budget (v:8 + cover)", async () => {
    const tagBody = 25 * 1024 * 1024;
    const fixture = buildHugeTagMp3(tagBody, {
      title: "Big Tag Song",
      artist: "Big Tag Artist",
      album: "Big Tag Album",
      image: makeJpeg(),
    });
    makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "big-tag-id",
      "tok",
      fixture.length,
      "big-tag.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Big Tag Song");
    expect(r.artist).toBe("Big Tag Artist");
    expect(r.pictureData).toEqual(new Uint8Array([1, 2, 3]));
    // Default tokenizer + one raised-budget tokenizer (tag + header + 1MB slack).
    expect(tokenizerConstructions).toHaveLength(2);
    expect(tokenizerConstructions[1]?.budgetBytes).toBe(
      tagBody + 10 + 1024 * 1024,
    );
  });

  it("MP3 with a small ID3v2 tag uses a single tokenizer with the default budget", async () => {
    const fixture = buildMp3WithPicture(
      "Small Tag",
      "Small Artist",
      "Small Album",
      makeJpeg(),
    );
    makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "small-tag-id",
      "tok",
      fixture.length,
      "small.mp3",
    );
    expect(r.v).toBe(8);
    expect(tokenizerConstructions).toHaveLength(1);
    expect(tokenizerConstructions[0]?.budgetBytes).toBeUndefined();
  });

  it("MP3 without an ID3v2 header keeps the default budget (no ID3v2 logic)", async () => {
    const noTags = new Uint8Array(2048);
    noTags.set([0xff, 0xfb, 0x90, 0x00, ...new Array<number>(413).fill(0)], 0);
    makeFetchMock(noTags);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "untagged-budget-id",
      "tok",
      2048,
      "untagged.mp3",
    );
    expect(r.v).toBe(8);
    expect(tokenizerConstructions).toHaveLength(1);
    expect(tokenizerConstructions[0]?.budgetBytes).toBeUndefined();
  });

  it("syncsafe above TAG_BUDGET_MAX caps the raised budget at 32MB and falls back to the placeholder", async () => {
    // Declared tag body must FIT the file (a shorter file would end the read
    // with EndOfStreamError before the budget is ever hit), while still
    // exceeding the 32MB cap: declared 33MB body in a 33MB+ file.
    const declared = 33 * 1024 * 1024;
    const fixture = buildSparseMp3(declared, declared + 10 + 417);
    makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "huge-sync-id",
      "tok",
      fixture.length,
      "huge.mp3",
    );
    expect(r.v).toBe(V_PLACEHOLDER);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "metadata-fetch-failed",
        ) as unknown as string,
      }),
    );
    expect(tokenizerConstructions[1]?.budgetBytes).toBe(TAG_BUDGET_MAX);
  });
});

describe("cover POST to the Rust disk cache (S4)", () => {
  const fresh = () => import("./metadata");

  function mockCompress(thumbBytes: Uint8Array, fullBytes: Uint8Array) {
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data: maxSize >= FULL_MAX_SIZE ? fullBytes : thumbBytes,
        format: "image/jpeg",
        keptOriginal: false,
      }),
    );
  }

  beforeEach(() => {
    postCoverToCacheMock.mockReset();
    vi.mocked(compressCoverImage).mockReset();
    mockCompress(new Uint8Array([1, 2, 3]), new Uint8Array([9, 8, 7]));
  });

  it("POSTs thumb+full with the exact compressed bytes, then never again on cache-first hits", async () => {
    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3WithPicture("Pic Song", "Pic Artist", "Pic Album", makeJpeg()),
    );

    await getTrackMetadata("pic-post-1", "tok", 2048, "pic.mp3");

    expect(postCoverToCacheMock).toHaveBeenCalledTimes(2);
    expect(postCoverToCacheMock).toHaveBeenCalledWith(
      "pic-post-1",
      true,
      new Uint8Array([1, 2, 3]),
    );
    expect(postCoverToCacheMock).toHaveBeenCalledWith(
      "pic-post-1",
      false,
      new Uint8Array([9, 8, 7]),
    );

    postCoverToCacheMock.mockClear();
    await getTrackMetadata("pic-post-1", "tok", 2048, "pic.mp3");
    expect(postCoverToCacheMock).not.toHaveBeenCalled();
  });

  it("POSTs only the thumb when full compression fails (per-variant independence)", async () => {
    vi.mocked(compressCoverImage)
      .mockResolvedValueOnce({
        data: new Uint8Array([1, 2, 3]),
        format: "image/jpeg",
        keptOriginal: false,
      })
      .mockRejectedValueOnce(new Error("full encode failed"));

    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3WithPicture("Pic Song", "Pic Artist", "Pic Album", makeJpeg()),
    );

    const r = await getTrackMetadata("pic-post-2", "tok", 2048, "pic.mp3");

    expect(r.pictureData).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.pictureDataFull).toBeNull();
    expect(postCoverToCacheMock).toHaveBeenCalledTimes(1);
    expect(postCoverToCacheMock).toHaveBeenCalledWith(
      "pic-post-2",
      true,
      new Uint8Array([1, 2, 3]),
    );
  });

  it("does not POST any variant when the cover is not JPEG (PNG bytes kept original)", async () => {
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data:
          maxSize >= FULL_MAX_SIZE
            ? new Uint8Array([9, 8, 7])
            : new Uint8Array([1, 2, 3]),
        format: "image/png",
        keptOriginal: true,
      }),
    );

    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3WithPicture("PNG Song", "PNG Artist", "PNG Album", makeJpeg()),
    );

    const r = await getTrackMetadata("pic-post-png", "tok", 2048, "pic.mp3");
    expect(r.pictureFormat).toBe("image/png");
    expect(r.pictureDataFull).toEqual(new Uint8Array([9, 8, 7]));
    // Rust disk cache contract is JPEG-only — original PNG/WEBP bytes never POST.
    expect(postCoverToCacheMock).not.toHaveBeenCalled();
  });

  it("POSTs only the JPEG thumb when the full variant is a PNG original (mixed formats)", async () => {
    vi.mocked(compressCoverImage)
      .mockResolvedValueOnce({
        data: new Uint8Array([1, 2, 3]),
        format: "image/jpeg",
        keptOriginal: false,
      })
      .mockResolvedValueOnce({
        data: new Uint8Array([9, 8, 7]),
        format: "image/png",
        keptOriginal: true,
      });

    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3WithPicture(
        "Mixed Song",
        "Mixed Artist",
        "Mixed Album",
        makeJpeg(),
      ),
    );

    await getTrackMetadata("pic-post-mixed", "tok", 2048, "pic.mp3");
    expect(postCoverToCacheMock).toHaveBeenCalledTimes(1);
    expect(postCoverToCacheMock).toHaveBeenCalledWith(
      "pic-post-mixed",
      true,
      new Uint8Array([1, 2, 3]),
    );
  });

  it("does not POST when there is no picture at all", async () => {
    const { getTrackMetadata } = await fresh();
    makeFetchMock(buildMp3Fixture("No Pic", "No Pic Artist", "No Pic Album"));

    await getTrackMetadata("pic-post-3", "tok", 2048, "pic.mp3");

    expect(postCoverToCacheMock).not.toHaveBeenCalled();
  });

  it("a rejecting POST never blocks the entry (fire-and-forget, non-fatal)", async () => {
    const rejecting = Promise.reject(new Error("post boom"));
    rejecting.catch(() => {});
    postCoverToCacheMock.mockReturnValue(rejecting);

    const { getTrackMetadata } = await fresh();
    makeFetchMock(
      buildMp3WithPicture("Pic Song", "Pic Artist", "Pic Album", makeJpeg()),
    );

    const r = await getTrackMetadata("pic-post-4", "tok", 2048, "pic.mp3");

    expect(r.v).toBe(8);
    expect(r.pictureData).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.pictureDataFull).toEqual(new Uint8Array([9, 8, 7]));
    expect(postCoverToCacheMock).toHaveBeenCalledTimes(2);
  });
});

describe("getTrackMetadata large-file head-only parse (Fix E)", () => {
  const fresh = () => import("./metadata");

  // Virtual size of the Drive-side file. The fixture only materializes the
  // head region (tag + 4 frames + zero padding) — reads past it come back
  // empty from the mock, which mirrors a tail read that cannot be served.
  const LARGE_VIRTUAL_SIZE = 150 * 1024 * 1024;
  const HEAD_BYTES = 131_072;
  // MPEG1 Layer III, 128kbps, 44.1kHz, stereo → 417-byte frames.
  const FRAME_BYTES = 417;

  function rangeStart(range: string | null): number {
    const m = /bytes=(\d+)-/.exec(range ?? "");
    return m ? Number(m[1]) : -1;
  }

  // First MPEG frame with an optional Xing tag. Xing layout (music-metadata
  // readXingHeader): frame header(4) + side info(32, stereo MPEG1) + "Xing" +
  // flags + numFrames + streamSize. Flags 0x03 = numFrames + streamSize
  // present — both are required for music-metadata to set a Xing duration.
  // byte2 defaults to 0x90 (MPEG1 Layer III 128kbps 44.1kHz); callers can
  // pass another value (e.g. 0xa0 = 160kbps) to build a VBR stream.
  function buildMpegFrame(
    withXing: boolean,
    numFrames: number,
    byte2 = 0x90,
  ): number[] {
    const header = [0xff, 0xfb, byte2, 0x00];
    const sideInfo = new Array<number>(32).fill(0);
    if (!withXing) {
      return [
        ...header,
        ...sideInfo,
        ...new Array<number>(FRAME_BYTES - 4 - 32).fill(0),
      ];
    }
    const xing = [
      ...Array.from("Xing", (c) => c.charCodeAt(0)),
      0x00,
      0x00,
      0x00,
      0x03, // flags: numFrames + streamSize present
      ...u32be(numFrames),
      // streamSize must be NONZERO: music-metadata only trusts a Xing
      // duration when `infoTag.streamSize` is truthy (MpegParser.js).
      ...u32be(numFrames * FRAME_BYTES),
    ];
    return [
      ...header,
      ...sideInfo,
      ...xing,
      ...new Array<number>(FRAME_BYTES - 4 - 32 - xing.length).fill(0),
    ];
  }

  // ID3v2.3 tag carrying TIT2/TPE1/TALB + an APIC cover, as byte array.
  function buildId3v2Tag(
    title: string,
    artist: string,
    album: string,
    image: Uint8Array,
  ): number[] {
    const frames = [
      ...id3Frame("TIT2", title),
      ...id3Frame("TPE1", artist),
      ...id3Frame("TALB", album),
      ...apicFrame(image),
    ];
    return [
      0x49,
      0x44,
      0x33,
      0x03,
      0x00,
      0x00,
      ...syncsafe32(frames.length),
      ...frames,
    ];
  }

  // tag + 4 identical MPEG frames (the parser reaches the frameCount===4 CBR /
  // quit path that derives duration from the tokenizer size) + zeros to 200KB.
  function buildLargeMp3(opts: {
    title: string;
    artist: string;
    album: string;
    image: Uint8Array;
    withXing: boolean;
    numFrames: number;
    vbr?: boolean;
  }): Uint8Array {
    const { title, artist, album, image, withXing, numFrames, vbr } = opts;
    const tag = buildId3v2Tag(title, artist, album, image);
    // vbr: frames 2-4 carry a different bitrate (0xA0 = 160kbps vs 128kbps)
    // so music-metadata never classifies the stream as CBR.
    const frame = buildMpegFrame(withXing, numFrames);
    const vbrFrame = buildMpegFrame(withXing, numFrames, 0xa0);
    const rest = vbr ? [vbrFrame, vbrFrame, vbrFrame] : [frame, frame, frame];
    const body = [...tag, ...frame, ...rest.flat()];
    const out = new Uint8Array(200 * 1024);
    out.set(body, 0);
    return out;
  }

  // tag + 4 identical CBR frames (128kbps 44.1kHz, no Xing): a large file
  // whose duration music-metadata CAN derive exactly from the real file size
  // (finalize on the CBR quit path). Returns the tag end offset (= the first
  // MPEG frame sync) so tests can reproduce the expected duration math.
  function buildLargeCbrMp3(opts: {
    title: string;
    artist: string;
    album: string;
    image: Uint8Array;
  }): { bytes: Uint8Array; tagEnd: number } {
    const { title, artist, album, image } = opts;
    const tag = buildId3v2Tag(title, artist, album, image);
    const frame = buildMpegFrame(false, 0);
    const body = [...tag, ...frame, ...frame, ...frame, ...frame];
    const bytes = new Uint8Array(200 * 1024);
    bytes.set(body, 0);
    return { bytes, tagEnd: tag.length };
  }

  function mockCompress(thumbBytes: Uint8Array, fullBytes: Uint8Array) {
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data: maxSize >= FULL_MAX_SIZE ? fullBytes : thumbBytes,
        format: "image/jpeg",
        keptOriginal: false,
      }),
    );
  }

  beforeEach(() => {
    vi.mocked(compressCoverImage).mockReset();
    mockCompress(new Uint8Array([1, 2, 3]), new Uint8Array([9, 8, 7]));
  });

  it("150MB MP3 with Xing+cover at the head: v:8 entry, cover, real duration, zero tail requests", async () => {
    const fixture = buildLargeMp3({
      title: "Big Xing Song",
      artist: "Big Xing Artist",
      album: "Big Xing Album",
      image: makeJpeg(),
      withXing: true,
      numFrames: 200_000,
    });
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "large-xing",
      "tok",
      LARGE_VIRTUAL_SIZE,
      "large.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Big Xing Song");
    expect(r.artist).toBe("Big Xing Artist");
    expect(r.pictureData).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.durationEstimated).toBe(false);
    expect(r.duration).toBeCloseTo((200_000 * 1152) / 44100, 6);
    for (const call of calls) {
      expect(rangeStart(call.range)).toBeLessThan(HEAD_BYTES);
    }
  });

  it("150MB MP3 WITHOUT Xing (VBR): v:8 entry with duration 0 + estimated (no bogus size-derived seconds, no tail requests)", async () => {
    const fixture = buildLargeMp3({
      title: "No Xing Song",
      artist: "No Xing Artist",
      album: "No Xing Album",
      image: makeJpeg(),
      withXing: false,
      numFrames: 0,
      vbr: true,
    });
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "large-noxing",
      "tok",
      LARGE_VIRTUAL_SIZE,
      "large.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("No Xing Song");
    expect(r.duration).toBe(0);
    expect(r.durationEstimated).toBe(true);
    // Head-only parse: at most the head prefetch (no tag-region / tail reads).
    expect(calls.length).toBeLessThanOrEqual(2);
    for (const call of calls) {
      expect(rangeStart(call.range)).toBeLessThan(HEAD_BYTES);
    }
  });

  it("150MB MP3 WITHOUT Xing (CBR): real duration derived from the real size, zero tail/scan requests", async () => {
    const fixture = buildLargeCbrMp3({
      title: "Big CBR Song",
      artist: "Big CBR Artist",
      album: "Big CBR Album",
      image: makeJpeg(),
    });
    const { calls } = makeFetchMock(fixture.bytes);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "large-cbr",
      "tok",
      LARGE_VIRTUAL_SIZE,
      "large.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Big CBR Song");
    expect(r.durationEstimated).toBe(false);
    // music-metadata finalize: round((size - mpegOffset) / frameSize) * 1152 / 44100
    const expectedDuration =
      (Math.round((LARGE_VIRTUAL_SIZE - fixture.tagEnd) / FRAME_BYTES) * 1152) /
      44100;
    expect(r.duration).toBeCloseTo(expectedDuration, 6);
    expect(r.duration).toBeGreaterThan(1000);
    // Head prefetch + the re-read of the tag region on the real-size tokenizer
    // — never a tail/scan fetch (the parser quits at the 4th frame).
    expect(calls.length).toBeLessThanOrEqual(3);
    for (const call of calls) {
      expect(rangeStart(call.range)).toBeLessThan(HEAD_BYTES);
    }
  });

  it("150MB CBR MP3 WITHOUT an ID3v2 tag stays head-clamped (duration 0, no tail fetch)", async () => {
    // No ID3v2 tag: detectFormat cannot identify the file as mp3 AND
    // music-metadata's skipPostHeaders tail-read skip needs at least one
    // parsed tag (hasAny) — so a real-size grant would range-fetch the tail.
    const frame = buildMpegFrame(false, 0);
    const body = [...frame, ...frame, ...frame, ...frame];
    const fixture = new Uint8Array(200 * 1024);
    fixture.set(body, 0);
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "large-cbr-untagged",
      "tok",
      LARGE_VIRTUAL_SIZE,
      "large.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.duration).toBe(0);
    expect(r.durationEstimated).toBe(true);
    for (const call of calls) {
      expect(rangeStart(call.range)).toBeLessThan(HEAD_BYTES);
    }
  });

  it("exactly-100MB CBR file (at the threshold, NOT large): full parse path with tail ID3v1 read, real duration", async () => {
    const fixture = buildLargeCbrMp3({
      title: "Boundary Song",
      artist: "Boundary Artist",
      album: "Boundary Album",
      image: makeJpeg(),
    });
    const { calls } = makeFetchMock(fixture.bytes, {
      virtualSize: 100 * 1024 * 1024,
    });
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "at-threshold",
      "tok",
      100 * 1024 * 1024,
      "large.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.durationEstimated).toBe(false);
    expect(r.duration).toBeCloseTo(
      (Math.round((100 * 1024 * 1024 - fixture.tagEnd) / FRAME_BYTES) * 1152) /
        44100,
      6,
    );
    // NOT clamped: the ID3v1 tail read beyond the head region still fires
    // (same as any small file — below-threshold parses are untouched).
    expect(calls.some((c) => rangeStart(c.range) >= HEAD_BYTES)).toBe(true);
  });

  it("100MB+1 CBR file (just above the threshold): real size granted, no tail fetch", async () => {
    const fixture = buildLargeCbrMp3({
      title: "Just Large Song",
      artist: "Just Large Artist",
      album: "Just Large Album",
      image: makeJpeg(),
    });
    const { calls } = makeFetchMock(fixture.bytes);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "just-large",
      "tok",
      100 * 1024 * 1024 + 1,
      "large.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.durationEstimated).toBe(false);
    expect(r.duration).toBeCloseTo(
      (Math.round((100 * 1024 * 1024 + 1 - fixture.tagEnd) / FRAME_BYTES) *
        1152) /
        44100,
      6,
    );
    expect(calls.length).toBeLessThanOrEqual(3);
    for (const call of calls) {
      expect(rangeStart(call.range)).toBeLessThan(HEAD_BYTES);
    }
  });

  it("90MB file (below threshold) keeps the full parse path — tail ID3v1 read still attempted", async () => {
    const fixture = buildLargeMp3({
      title: "Mid Song",
      artist: "Mid Artist",
      album: "Mid Album",
      image: makeJpeg(),
      withXing: true,
      numFrames: 1_000,
    });
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "below-threshold",
      "tok",
      90 * 1024 * 1024,
      "mid.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.duration).toBeCloseTo((1_000 * 1152) / 44100, 6);
    // NOT clamped: the ID3v1 tail read still fires beyond HEAD_BYTES.
    expect(calls.some((c) => rangeStart(c.range) >= HEAD_BYTES)).toBe(true);
  });
});

describe("getTrackMetadata prefetchRange (one request per region, was many chunk requests)", () => {
  const fresh = () => import("./metadata");

  function mockCompress(thumbBytes: Uint8Array, fullBytes: Uint8Array) {
    vi.mocked(compressCoverImage).mockImplementation((_data, _fmt, maxSize) =>
      Promise.resolve({
        data: maxSize >= FULL_MAX_SIZE ? fullBytes : thumbBytes,
        format: "image/jpeg",
        keptOriginal: false,
      }),
    );
  }

  beforeEach(() => {
    vi.mocked(compressCoverImage).mockReset();
    mockCompress(new Uint8Array([1, 2, 3]), new Uint8Array([9, 8, 7]));
  });

  it("MP3 with a 600KB ID3v2 tag: head + ONE tag-region prefetch (2 requests, was ~9 chunk requests)", async () => {
    const fixture = buildHugeTagMp3(600 * 1024, {
      title: "Big Tag",
      artist: "Big Artist",
      album: "Big Album",
      image: makeJpeg(),
    });
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "prefetch-tag-600k",
      "tok",
      fixture.length,
      "big.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Big Tag");
    // head prefetch (1) + tag-region prefetch (1); the whole parse reads from
    // the seeded cache — before the fix the tag body alone cost 8 chunk reads.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.range).toBe("bytes=0-131071");
    expect(calls[1]?.range).toBe(`bytes=0-${String(fixture.length - 1)}`);
  });

  it("MP3 with a 4MB ID3v2 tag (fits the chunk-cache LRU): 2 requests total (was ~64)", async () => {
    const fixture = buildHugeTagMp3(4 * 1024 * 1024, {
      title: "Big Tag Song",
      artist: "Big Tag Artist",
      album: "Big Tag Album",
      image: makeJpeg(),
    });
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "prefetch-tag-4m",
      "tok",
      fixture.length,
      "big-tag.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Big Tag Song");
    expect(r.pictureData).toEqual(new Uint8Array([1, 2, 3]));
    // head prefetch on the default tokenizer (1) + tag-region prefetch (1) —
    // the whole 4MB tag parse is served from the seeded cache.
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("MP3 with a 25MB ID3v2 tag (region exceeds the chunk-cache LRU): prefetch skipped, raised-budget parse still yields v:8", async () => {
    const fixture = buildHugeTagMp3(25 * 1024 * 1024, {
      title: "Big Tag Song",
      artist: "Big Tag Artist",
      album: "Big Tag Album",
      image: makeJpeg(),
    });
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "prefetch-tag-25m-skip",
      "tok",
      fixture.length,
      "big-tag.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Big Tag Song");
    expect(tokenizerConstructions).toHaveLength(2);
    // A 25MB region cannot survive the 128-chunk LRU — seeding it would
    // double-spend the raised budget (evicted chunks re-fetched), so the
    // prefetch is skipped and the parse reads chunked within the raised
    // budget, exactly as before prefetchRange existed.
    expect(calls.length).toBeGreaterThan(100);
  });

  it("m4a non-faststart with a 1MB tail: tail scan prefetch (3 requests total, was 17)", async () => {
    const fixture = buildM4aNonFaststart(3 * 1024 * 1024);
    const { calls } = makeFetchMock(fixture);
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "m4a-prefetch-tail",
      "tok",
      fixture.length,
      "slow.m4a",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("slow");
    expect(filesUpdate).toHaveBeenCalledWith("m4a-prefetch-tail", {
      metadata: { format: "m4a", streamUnplayable: true },
    });
    // head (1) + the parse's moov-chunk read (1) + ONE tail prefetch (1);
    // previously the 1MB tail scan alone was 16 chunk requests (17 total).
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("a failed tag prefetch falls back to the chunked parse and still yields v:8", async () => {
    const fixture = buildHugeTagMp3(600 * 1024, {
      title: "Big Tag",
      artist: "Big Artist",
      album: "Big Album",
      image: makeJpeg(),
    });
    const { mock } = makeFetchMock(fixture);
    const serveSlice = mock.getMockImplementation();
    if (!serveSlice)
      throw new Error("makeFetchMock must install an implementation");
    // head succeeds; the tag-region prefetch request fails; everything after
    // is served normally so the chunked fallback can complete the parse.
    mock
      .mockImplementationOnce((...args) => serveSlice(...args))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation((...args) => serveSlice(...args));
    const { getTrackMetadata } = await fresh();

    const r = await getTrackMetadata(
      "prefetch-fail",
      "tok",
      fixture.length,
      "big.mp3",
    );
    expect(r.v).toBe(8);
    expect(r.title).toBe("Big Tag");
    // the fallback re-read the tag region chunked (8 chunks past the head)
    expect(mock).toHaveBeenCalledTimes(10);
  });

  it("LARGE file (150MB) with a tag larger than the clamped head: NO tag prefetch, head-only fetch", async () => {
    const fixture = buildSparseMp3(200 * 1024, 131_072);
    const { calls } = makeFetchMock(fixture, {
      virtualSize: 150 * 1024 * 1024,
    });
    const { getTrackMetadata } = await fresh();

    await getTrackMetadata(
      "large-huge-tag",
      "tok",
      150 * 1024 * 1024,
      "huge.mp3",
    );
    // the head prefetch is the ONLY request: the tag region must NOT be
    // re-fetched for a large file whose tag cannot fit the clamped head.
    expect(calls).toHaveLength(1);
  });
});
