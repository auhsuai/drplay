import { expect, test, describe, it, beforeEach } from "vitest";
import { getTrackMetadata, cacheTrackMetadata, clearAllMetadataCache, metadataCache } from "./metadata";

// This app streams directly from Google Drive with no local tag/cover
// database: `getTrackMetadata` is now a pure, synchronous-ish derivation from
// the filename — no IPC, no network fetch, no cover art.

beforeEach(() => {
  clearAllMetadataCache();
});

test("getTrackMetadata derives the title from the filename (strips extension)", async () => {
  const meta = await getTrackMetadata("fid1", undefined, 1234, "My Great Song.mp3");
  expect(meta.title).toBe("My Great Song");
  expect(meta.artist).toBe("Unknown Artist");
  expect(meta.size).toBe(1234);
});

test("getTrackMetadata falls back to a default name when none is given", async () => {
  const meta = await getTrackMetadata("fid-none");
  expect(meta.title).toBe("audio");
});

test("getTrackMetadata caches by fileId and returns the same object on a second call", async () => {
  const first = await getTrackMetadata("fid2", undefined, 100, "Song.flac");
  const second = await getTrackMetadata("fid2", undefined, 999, "Different Name.flac");
  // Second call hits the cache — same object, original filename-derived title.
  expect(second).toBe(first);
  expect(second.title).toBe("Song");
});

test("cacheTrackMetadata stores and returns the entry as-is", () => {
  const entry = { title: "t", artist: "a", duration: 0, durationEstimated: true };
  const ret = cacheTrackMetadata("fid3", entry);
  expect(ret).toBe(entry);
  expect(metadataCache["fid3"]).toBe(entry);
});

describe("clearAllMetadataCache", () => {
  it("empties the in-memory cache", () => {
    cacheTrackMetadata("fid4", { title: "t", artist: "a", duration: 0, durationEstimated: true });
    clearAllMetadataCache();
    expect(Object.keys(metadataCache).length).toBe(0);
  });
});
