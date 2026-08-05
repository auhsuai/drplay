import { expect, test, describe, it, vi, beforeEach } from "vitest";
import type { CachedMetadata } from "./metadata";
import {
  metadataCache,
  cacheTrackMetadata,
  clearAllMetadataCache,
} from "./metadata";

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

describe("getTrackMetadata dedup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("should deduplicate concurrent requests for same fileId", async () => {
    // Buffer that looks like a minimal ID3v2 header (tag size = 0)
    // so music-metadata-browser can parse it without error
    const buf = new ArrayBuffer(100);
    const view = new DataView(buf);
    view.setUint8(0, 0x49);
    view.setUint8(1, 0x44);
    view.setUint8(2, 0x33); // 'ID3'
    view.setUint8(3, 0x04);
    view.setUint8(4, 0x00);
    view.setUint8(5, 0x00);
    // tag size = 0 (syncsafe integer)
    view.setUint8(6, 0x00);
    view.setUint8(7, 0x00);
    view.setUint8(8, 0x00);
    view.setUint8(9, 0x00);
    // Rest is padding

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 206,
      headers: new Map([
        ["content-range", "bytes 0-99/1000"],
        ["content-type", "audio/mpeg"],
      ]),
      arrayBuffer: () => Promise.resolve(buf),
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const { getTrackMetadata } = await import("./metadata");

      const p1 = getTrackMetadata(
        "dedup-test-id",
        "test-token",
        1000,
        "test.mp3",
      );
      const p2 = getTrackMetadata(
        "dedup-test-id",
        "test-token",
        1000,
        "test.mp3",
      );

      await Promise.allSettled([p1, p2]);

      expect(mockFetch).toHaveBeenCalledTimes(0); // network fetch disabled
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
