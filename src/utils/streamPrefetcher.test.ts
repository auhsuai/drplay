import { describe, it, expect, beforeEach } from "vitest";
import {
  getPrefetchedStreamUrl,
  getPrefetchedStreamCount,
  prefetchVisibleTracks,
  clearPrefetchedStreams,
} from "./streamPrefetcher";

describe("streamPrefetcher", () => {
  beforeEach(() => {
    clearPrefetchedStreams();
  });

  it("returns undefined for a url that was never cached", () => {
    expect(getPrefetchedStreamUrl("x")).toBeUndefined();
  });

  it("caches /drive-stream/{id} for each given id", () => {
    prefetchVisibleTracks(["a", "b"]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a");
    expect(getPrefetchedStreamUrl("b")).toBe("/drive-stream/b");
  });

  it("skips empty ids", () => {
    prefetchVisibleTracks(["", "c"]);
    expect(getPrefetchedStreamUrl("")).toBeUndefined();
    expect(getPrefetchedStreamUrl("c")).toBe("/drive-stream/c");
  });

  it("does not overwrite an already cached url", () => {
    prefetchVisibleTracks(["a"]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a");
    prefetchVisibleTracks(["a"]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a");
  });

  it("evicts the oldest entry beyond MAX_CACHE (200)", () => {
    const ids = Array.from({ length: 201 }, (_, i) => `id_${String(i)}`);
    prefetchVisibleTracks(ids);
    expect(getPrefetchedStreamUrl("id_0")).toBeUndefined();
    expect(getPrefetchedStreamUrl("id_200")).toBe("/drive-stream/id_200");
    expect(getPrefetchedStreamUrl("id_199")).toBe("/drive-stream/id_199");
  });

  it("clears all cached urls", () => {
    prefetchVisibleTracks(["a", "b", "c"]);
    clearPrefetchedStreams();
    expect(getPrefetchedStreamUrl("a")).toBeUndefined();
    expect(getPrefetchedStreamUrl("b")).toBeUndefined();
    expect(getPrefetchedStreamUrl("c")).toBeUndefined();
  });

  it("reports the current number of cached stream urls", () => {
    expect(getPrefetchedStreamCount()).toBe(0);
    prefetchVisibleTracks(["a", "b"]);
    expect(getPrefetchedStreamCount()).toBe(2);
    clearPrefetchedStreams();
    expect(getPrefetchedStreamCount()).toBe(0);
  });
});
