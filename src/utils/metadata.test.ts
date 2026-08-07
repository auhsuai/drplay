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
  opts: { forceStatus?: number; reject?: boolean } = {},
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
    const end = Math.min(Number(m[2]), fileBytes.length - 1);
    const slice = fileBytes.subarray(start, end + 1);
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

beforeEach(() => {
  memoryStore.clear();
  filesUpdate.mockClear();
  tokenizerConstructions.length = 0;
  vi.mocked(captureError).mockClear();
  clearAllMetadataCache();
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

  it("stores the compressed thumb + format and keeps pictureDataFull out of IDB", async () => {
    const { getTrackMetadata } = await fresh();
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
    expect(stored?.data.pictureDataFull).toBeNull();
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
