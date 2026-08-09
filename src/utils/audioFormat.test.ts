import { describe, expect, it } from "vitest";
import {
  detectFormat,
  isMpegCbr,
  scanTailForMoov,
  walkMp4TopBoxes,
} from "./audioFormat";

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

describe("isMpegCbr", () => {
  // MPEG1 Layer III bitrate table (kbps) by bitrate index 1..14 — same table
  // the implementation reads, duplicated here so the fixture frame sizes are
  // self-contained (a wrong table in the implementation must fail the test).
  const MPEG1_L3_KBPS = [
    32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ];
  const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];
  // MPEG2(.5) Layer III bitrate table (kbps) by bitrate index 1..14.
  const MPEG2_L3_KBPS = [
    8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
  ];

  // One MPEG frame: 4-byte header + zeroed body padded to the exact ISO
  // frame size (floor(samplesPerFrame/8 * bitrate / sampleRate) + padding).
  function frame(
    byte1: number,
    bitrateIndex: number,
    sampleRateIndex: number,
    samplesPerFrame: number,
    sampleRate: number,
    bitrateKbps: number,
    padding: boolean,
  ): number[] {
    const b2 =
      (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding ? 0x02 : 0x00);
    const frameSize =
      Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) +
      (padding ? 1 : 0);
    return [
      0xff,
      byte1,
      b2,
      0x00,
      ...new Array<number>(Math.max(0, frameSize - 4)).fill(0),
    ];
  }

  // MPEG1 Layer III 128kbps 44.1kHz stereo frame (417 bytes).
  function mpeg1L3(
    bitrateIndex: number,
    sampleRateIndex = 0,
    padding = false,
  ): number[] {
    const kbps = MPEG1_L3_KBPS[bitrateIndex - 1] ?? 128;
    const sr = MPEG1_SAMPLE_RATES[sampleRateIndex] ?? 44100;
    return frame(0xfb, bitrateIndex, sampleRateIndex, 1152, sr, kbps, padding);
  }

  // MPEG2 Layer III 80kbps 22050Hz frame (261 bytes).
  function mpeg2L3(bitrateIndex: number): number[] {
    const kbps = MPEG2_L3_KBPS[bitrateIndex - 1] ?? 80;
    return frame(0xf3, bitrateIndex, 0, 576, 22050, kbps, false);
  }

  // Minimal ID3v2.3 header (10 bytes, empty body) so the frame scan must skip
  // the tag region.
  function id3v2Header(): number[] {
    return [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  }

  it("detects a constant-bitrate stream from 4 identical frames", () => {
    const head = new Uint8Array([
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(true);
  });

  it("rejects a variable-bitrate stream (bitrate changes between frames)", () => {
    const head = new Uint8Array([
      ...mpeg1L3(9), // 128kbps
      ...mpeg1L3(10), // 160kbps
      ...mpeg1L3(11), // 192kbps
      ...mpeg1L3(9), // 128kbps
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(false);
  });

  it("accepts CBR frames behind an ID3v2 tag (scan starts after the tag)", () => {
    const head = new Uint8Array([
      ...id3v2Header(),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(true);
  });

  it("accepts a CBR stream whose frames carry the padding bit (real encoders vary padding)", () => {
    const head = new Uint8Array([
      ...mpeg1L3(9, 0, false), // 417 bytes
      ...mpeg1L3(9, 0, true), // 418 bytes
      ...mpeg1L3(9, 0, false),
      ...mpeg1L3(9, 0, false),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(true);
  });

  it("rejects a stream whose frames change sample rate", () => {
    const head = new Uint8Array([
      ...mpeg1L3(9, 0), // 44.1kHz
      ...mpeg1L3(9, 1), // 48kHz
      ...mpeg1L3(9, 0),
      ...mpeg1L3(9, 0),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(false);
  });

  it("accepts MPEG2 Layer III CBR frames (72*bitrate/sr frame size)", () => {
    const head = new Uint8Array([
      ...mpeg2L3(9),
      ...mpeg2L3(9),
      ...mpeg2L3(9),
      ...mpeg2L3(9),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(true);
  });

  it("rejects a reserved MPEG version index", () => {
    const head = new Uint8Array([
      ...frame(0xeb, 9, 0, 1152, 44100, 128, false), // version index 01 = reserved
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(false);
  });

  it("rejects a reserved layer index (ADTS framing)", () => {
    const head = new Uint8Array([
      ...frame(0xf9, 9, 0, 1152, 44100, 128, false), // layer index 00 = reserved
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(false);
  });

  it("rejects a free-format bitrate index (0)", () => {
    const head = new Uint8Array([
      ...frame(0xfb, 0, 0, 1152, 44100, 0, false),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(false);
  });

  it("rejects a reserved bitrate index (15)", () => {
    const head = new Uint8Array([
      ...frame(0xfb, 15, 0, 1152, 44100, 0, false),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(false);
  });

  it("rejects a head too short for 4 frames", () => {
    const head = new Uint8Array([
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9), // only 3 frames
    ]);
    expect(isMpegCbr(head, "mp3")).toBe(false);
  });

  it("returns false for a head with no frame sync", () => {
    expect(isMpegCbr(new Uint8Array(64).fill(0xde), "mp3")).toBe(false);
    expect(isMpegCbr(new Uint8Array(0), "mp3")).toBe(false);
  });

  it("returns false for non-mp3 formats even with valid MPEG bytes", () => {
    const head = new Uint8Array([
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
      ...mpeg1L3(9),
    ]);
    expect(isMpegCbr(head, "flac")).toBe(false);
    expect(isMpegCbr(head, "m4a")).toBe(false);
  });
});

describe("walkMp4TopBoxes", () => {
  it("[ftyp][moov][mdat] → moovBeforeMdat=true", () => {
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

  it("[ftyp][mdat size 4GB] → mdatBeforeMoov=true and terminates (no infinite loop)", () => {
    const data = new Uint8Array([
      ...box(8, "ftyp"),
      ...box(0xffffffff, "mdat"),
      ...box(8, "moov"),
    ]);
    const walk = walkMp4TopBoxes(data, 1_000_000_000);
    expect(walk.mdatBeforeMoov).toBe(true);
    expect(walk.moovBeforeMdat).toBe(false);
  });

  it("[ftyp][moov extends beyond buffer] → moovBeforeMdat=true (moov starts in head)", () => {
    const data = new Uint8Array([...box(8, "ftyp"), ...box(0x10000, "moov")]);
    const walk = walkMp4TopBoxes(data, 200_000);
    expect(walk.moovBeforeMdat).toBe(true);
    expect(walk.mdatBeforeMoov).toBe(false);
  });

  it("empty buffer → both flags false", () => {
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
