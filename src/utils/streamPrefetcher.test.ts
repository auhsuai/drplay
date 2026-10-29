import { describe, it, expect, beforeEach } from "vitest";
import {
  buildStreamUrl,
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
    prefetchVisibleTracks([{ id: "a" }, { id: "b" }]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a");
    expect(getPrefetchedStreamUrl("b")).toBe("/drive-stream/b");
  });

  it("threads the originalName into the cached URL when playable", () => {
    prefetchVisibleTracks([{ id: "a", originalName: "song.flac" }]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a?ext=flac");
  });

  it("caches plain URLs for tracks without a name", () => {
    prefetchVisibleTracks([{ id: "a" }]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a");
  });

  it("caches plain URLs for a name outside the playable allowlist", () => {
    // `.wvx`/`.tak2` are look-alikes, not extensions in the allowlist.
    prefetchVisibleTracks([{ id: "a", originalName: "song.wvx" }]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a");
  });

  it("skips empty ids", () => {
    prefetchVisibleTracks([{ id: "" }, { id: "c" }]);
    expect(getPrefetchedStreamUrl("")).toBeUndefined();
    expect(getPrefetchedStreamUrl("c")).toBe("/drive-stream/c");
  });

  it("does not overwrite an already cached url", () => {
    prefetchVisibleTracks([{ id: "a" }]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a");
    prefetchVisibleTracks([{ id: "a", originalName: "x.flac" }]);
    expect(getPrefetchedStreamUrl("a")).toBe("/drive-stream/a");
  });

  it("evicts the oldest entry beyond MAX_CACHE (200)", () => {
    const ids = Array.from({ length: 201 }, (_, i) => ({
      id: `id_${String(i)}`,
    }));
    prefetchVisibleTracks(ids);
    expect(getPrefetchedStreamUrl("id_0")).toBeUndefined();
    expect(getPrefetchedStreamUrl("id_200")).toBe("/drive-stream/id_200");
    expect(getPrefetchedStreamUrl("id_199")).toBe("/drive-stream/id_199");
  });

  it("clears all cached urls", () => {
    prefetchVisibleTracks([{ id: "a" }, { id: "b" }, { id: "c" }]);
    clearPrefetchedStreams();
    expect(getPrefetchedStreamUrl("a")).toBeUndefined();
    expect(getPrefetchedStreamUrl("b")).toBeUndefined();
    expect(getPrefetchedStreamUrl("c")).toBeUndefined();
  });

  it("reports the current number of cached stream urls", () => {
    expect(getPrefetchedStreamCount()).toBe(0);
    prefetchVisibleTracks([{ id: "a" }, { id: "b" }]);
    expect(getPrefetchedStreamCount()).toBe(2);
    clearPrefetchedStreams();
    expect(getPrefetchedStreamCount()).toBe(0);
  });
});

describe("buildStreamUrl", () => {
  it("appends ?ext= for a playable extension", () => {
    expect(buildStreamUrl("abc", "song.flac")).toBe(
      "/drive-stream/abc?ext=flac",
    );
  });

  it("appends ?ext= for a playable extension in mixed case", () => {
    expect(buildStreamUrl("abc", "Song.FLAC")).toBe(
      "/drive-stream/abc?ext=flac",
    );
  });

  it("omits the param when no name is given", () => {
    expect(buildStreamUrl("abc")).toBe("/drive-stream/abc");
  });

  it("omits the param for a name outside the playable allowlist", () => {
    expect(buildStreamUrl("abc", "song.wvx")).toBe("/drive-stream/abc");
    expect(buildStreamUrl("abc", "song.tak2")).toBe("/drive-stream/abc");
  });

  it("omits the param for a name without an extension", () => {
    expect(buildStreamUrl("abc", "song")).toBe("/drive-stream/abc");
  });

  it("encodes the fileId", () => {
    expect(buildStreamUrl("a b/c", "x.mp3")).toBe(
      "/drive-stream/a%20b%2Fc?ext=mp3",
    );
  });

  it("appends ?ext= for the wma/aif/aiff/oga/m4b containers", () => {
    expect(buildStreamUrl("abc", "song.wma")).toBe("/drive-stream/abc?ext=wma");
    expect(buildStreamUrl("abc", "song.aif")).toBe("/drive-stream/abc?ext=aif");
    expect(buildStreamUrl("abc", "song.aiff")).toBe(
      "/drive-stream/abc?ext=aiff",
    );
    expect(buildStreamUrl("abc", "song.oga")).toBe("/drive-stream/abc?ext=oga");
    expect(buildStreamUrl("abc", "song.m4b")).toBe("/drive-stream/abc?ext=m4b");
  });

  // The APE/WavPack/TAK/DSD containers must travel the ?ext= lane too,
  // otherwise the SW would keep serving them as application/octet-stream.
  it("appends ?ext= for the ape/wv/tak/dsf/dff containers", () => {
    expect(buildStreamUrl("abc", "sh3.ape")).toBe("/drive-stream/abc?ext=ape");
    expect(buildStreamUrl("abc", "tone.wv")).toBe("/drive-stream/abc?ext=wv");
    expect(buildStreamUrl("abc", "lostchord.tak")).toBe(
      "/drive-stream/abc?ext=tak",
    );
    expect(buildStreamUrl("abc", "tone.dsf")).toBe("/drive-stream/abc?ext=dsf");
    expect(buildStreamUrl("abc", "tone.dff")).toBe("/drive-stream/abc?ext=dff");
  });

  it("appends ?ext= for the ape/wv/tak/dsf/dff containers in mixed case", () => {
    expect(buildStreamUrl("abc", "SH3.APE")).toBe("/drive-stream/abc?ext=ape");
    expect(buildStreamUrl("abc", "Tone.DFF")).toBe("/drive-stream/abc?ext=dff");
    expect(buildStreamUrl("abc", "Tone.WV")).toBe("/drive-stream/abc?ext=wv");
  });
});
