import { describe, expect, it } from "vitest";
import { detectFormat, scanTailForMoov, walkMp4TopBoxes } from "./audioFormat";

function buf(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function textAsBytes(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function box(size: number, type: string, payload: number[] = []): number[] {
  const t = textAsBytes(type);
  return [
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...t,
    ...payload,
  ];
}

describe("detectFormat", () => {
  it("detects mp3 from ID3 magic", () => {
    expect(
      detectFormat(
        buf(0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00),
        "x.mp3",
      ),
    ).toBe("mp3");
  });

  it("detects flac from fLaC magic", () => {
    const b = buf(0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22);
    expect(detectFormat(b, "x.flac")).toBe("flac");
  });

  it("detects opus from OggS page-1 OpusHead marker", () => {
    const b = new Uint8Array(64);
    b.set(textAsBytes("OggS"), 0);
    b[27] = 0x01; // one segment
    b[28] = 0x13; // segment length 19
    b.set(textAsBytes("OpusHead"), 29);
    expect(detectFormat(b, "x.opus")).toBe("opus");
  });

  it("detects ogg from OggS page-1 vorbis marker", () => {
    const b = new Uint8Array(64);
    b.set(textAsBytes("OggS"), 0);
    b[27] = 0x01;
    b[28] = 0x1e;
    b[29] = 0x01; // vorbis ID packet type
    b.set(textAsBytes("vorbis"), 30);
    expect(detectFormat(b, "x.ogg")).toBe("ogg");
  });

  it("returns ogg for OggS without identifiable marker", () => {
    const b = new Uint8Array(64);
    b.set(textAsBytes("OggS"), 0);
    expect(detectFormat(b, "x.ogg")).toBe("ogg");
  });

  it("detects m4a from ftyp magic", () => {
    const b = new Uint8Array(32);
    b.set(textAsBytes("ftyp"), 4);
    expect(detectFormat(b, "x.m4a")).toBe("m4a");
  });

  it("detects wav from RIFF+WAVE", () => {
    const b = new Uint8Array(16);
    b.set(textAsBytes("RIFF"), 0);
    b.set(textAsBytes("WAVE"), 8);
    expect(detectFormat(b, "x.wav")).toBe("wav");
  });

  it("detects aac from ADTS sync (0xFFFx, layer 00)", () => {
    // 0xFF 0xF1 = ADTS syncword + ID=1 + layer 00 + protection_absent
    expect(detectFormat(buf(0xff, 0xf1, 0x50, 0x80, 0x00), "x.aac")).toBe(
      "aac",
    );
  });

  it("does NOT misdetect an MP3 frame header (layer 01) as aac", () => {
    // 0xFF 0xFB = MPEG1 Layer III frame sync
    expect(detectFormat(buf(0xff, 0xfb, 0x90, 0x00), "x.mp3")).toBe("unknown");
  });

  it("returns unknown for garbage", () => {
    expect(
      detectFormat(buf(0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03), "x.bin"),
    ).toBe("unknown");
  });

  it("returns unknown for empty buffer", () => {
    expect(detectFormat(new Uint8Array(0), "x.mp3")).toBe("unknown");
  });
});

describe("walkMp4TopBoxes", () => {
  it("[ftyp][moov][mdat] â†’ moovBeforeMdat=true", () => {
    const data = new Uint8Array([
      ...box(20, "ftyp", new Array<number>(12).fill(0)),
      ...box(8, "moov"),
      ...box(8, "mdat"),
    ]);
    const walk = walkMp4TopBoxes(data, data.length);
    expect(walk.moovBeforeMdat).toBe(true);
    expect(walk.mdatBeforeMoov).toBe(false);
    expect(walk.moovOffset).toBe(20);
    expect(walk.moovSize).toBe(8);
  });

  it("[ftyp][mdat size 4GB] â†’ mdatBeforeMoov=true and terminates (no infinite loop)", () => {
    const data = new Uint8Array([
      ...box(8, "ftyp"),
      ...box(0xffffffff, "mdat"),
      ...box(8, "moov"),
    ]);
    const walk = walkMp4TopBoxes(data, 1_000_000_000);
    expect(walk.mdatBeforeMoov).toBe(true);
    expect(walk.moovBeforeMdat).toBe(false);
  });

  it("[ftyp][moov extends beyond buffer] â†’ moovBeforeMdat=true (moov starts in head)", () => {
    const data = new Uint8Array([...box(8, "ftyp"), ...box(0x10000, "moov")]);
    const walk = walkMp4TopBoxes(data, 200_000);
    expect(walk.moovBeforeMdat).toBe(true);
    expect(walk.mdatBeforeMoov).toBe(false);
  });

  it("empty buffer â†’ both flags false", () => {
    const walk = walkMp4TopBoxes(new Uint8Array(0), 1000);
    expect(walk.moovBeforeMdat).toBe(false);
    expect(walk.mdatBeforeMoov).toBe(false);
  });

  it("unknown boxes are skipped until moov", () => {
    const data = new Uint8Array([
      ...box(32, "free", new Array<number>(24).fill(0)),
      ...box(8, "moov"),
      ...box(8, "mdat"),
    ]);
    const walk = walkMp4TopBoxes(data, data.length);
    expect(walk.moovBeforeMdat).toBe(true);
    expect(walk.moovOffset).toBe(32);
  });
});

describe("scanTailForMoov", () => {
  it("finds moov box header at a 4-byte aligned offset in the tail", () => {
    // fileSize 200000, tail covers last 100 bytes: tail offset 0 == file offset 199900
    const tailSize = 100;
    const moovFileOffset = 199_920;
    const moovSize = 40;
    const tail = new Uint8Array(tailSize);
    tail.set(box(moovSize, "moov"), moovFileOffset - (200_000 - tailSize));
    const found = scanTailForMoov(tail, 200_000);
    expect(found).not.toBeNull();
    expect(found?.moovOffset).toBe(moovFileOffset);
    expect(found?.moovSize).toBe(moovSize);
  });

  it("rejects a moov whose size extends beyond the file size", () => {
    const tail = new Uint8Array(64);
    // moov at tail offset 8 (file offset = tailStart+8), size claims 2000 > remaining file
    tail.set(box(2000, "moov"), 8);
    const found = scanTailForMoov(tail, 1000);
    expect(found).toBeNull();
  });

  it("returns null when no moov present", () => {
    const tail = new Uint8Array(64);
    tail.set(textAsBytes("junk"), 8);
    tail.set(box(32, "free"), 24);
    expect(scanTailForMoov(tail, 200_000)).toBeNull();
  });

  it("finds moov with size 0 (extends to EOF)", () => {
    const tail = new Uint8Array(64);
    tail.set(box(0, "moov"), 12);
    const found = scanTailForMoov(tail, 200_000);
    expect(found?.moovOffset).toBe(200_000 - 64 + 12);
  });
});
