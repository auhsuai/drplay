import { describe, it, expect } from "vitest";
import { hasVideoExtension, isVideoNameNoise } from "./audioQuery";
import {
  classifyMediaKind,
  isPlayableMediaFile,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  PLAYABLE_VIDEO_EXTENSIONS,
} from "./mediaKind";

// Mirror of the production allowlist: exactly the containers verified
// end-to-end against real Google Drive samples through the localhost Range
// proxy and the shipped mpv engine. .mkv/.mp4 stay first because the
// order-sensitive toEqual below freezes the order — append, never reorder.
const ACCEPTED_VIDEO_EXTENSIONS = [
  ".mkv",
  ".mp4",
  ".webm",
  ".m4v",
  ".mov",
  ".avi",
  ".wmv",
  ".flv",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".3gp",
  ".vob",
  ".asf",
  ".ts",
];

// Containers mpv may well demux that this app has NOT verified end-to-end on
// the proxy. Each one must classify as audio (the documented default), i.e. it
// must not enter the library as video.
const NOT_YET_VIDEO_EXTENSIONS = [".divx", ".xvid", ".m2ts", ".mts", ".f4v"];

// The constants are spelled as literals in mediaKind.ts. Asserting the literal
// values here (not just `toBe(MEDIA_KIND_VIDEO)`) is deliberate: a missing or
// unresolvable export would make every kind comparison undefined===undefined and
// this whole file would pass vacuously.
describe("media kind constants", () => {
  it("are the literal wire values, not undefined", () => {
    expect(MEDIA_KIND_AUDIO).toBe("audio");
    expect(MEDIA_KIND_VIDEO).toBe("video");
    expect(MEDIA_KIND_AUDIO).not.toBe(MEDIA_KIND_VIDEO);
  });
});

describe("PLAYABLE_VIDEO_EXTENSIONS", () => {
  it("is exactly the verified containers, in order", () => {
    expect([...PLAYABLE_VIDEO_EXTENSIONS]).toEqual(ACCEPTED_VIDEO_EXTENSIONS);
  });

  it("holds no audio extension (the audio allowlist is not duplicated here)", () => {
    for (const ext of [
      ".mp3",
      ".flac",
      ".wav",
      ".ogg",
      ".m4a",
      ".aac",
      ".opus",
    ]) {
      expect(PLAYABLE_VIDEO_EXTENSIONS).not.toContain(ext);
    }
  });
});

describe("classifyMediaKind", () => {
  it("classifies every enabled video container as video", () => {
    // Compared against the literal "video", not the constant: a broken
    // export would then fail loudly instead of passing on undefined===undefined.
    expect(classifyMediaKind("Movie.mkv")).toBe("video");
    expect(classifyMediaKind("Movie.mp4")).toBe("video");
    for (const ext of PLAYABLE_VIDEO_EXTENSIONS) {
      expect(classifyMediaKind(`Movie${ext}`), ext).toBe("video");
    }
  });

  it("classifies every playable audio extension as audio", () => {
    expect(classifyMediaKind("Song.mp3")).toBe("audio");
    expect(classifyMediaKind("Song.flac")).toBe("audio");
    expect(classifyMediaKind("Song.wav")).toBe("audio");
    expect(classifyMediaKind("Song.ogg")).toBe("audio");
    expect(classifyMediaKind("Song.m4a")).toBe("audio");
    expect(classifyMediaKind("Song.aac")).toBe("audio");
    expect(classifyMediaKind("Song.opus")).toBe("audio");
  });

  it("case-insensitive on the extension (Drive preserves the upload's case)", () => {
    expect(classifyMediaKind("Movie.MKV")).toBe("video");
    expect(classifyMediaKind("Movie.MkV")).toBe("video");
    expect(classifyMediaKind("Movie.MP4")).toBe("video");
    expect(classifyMediaKind("Song.MP3")).toBe("audio");
    expect(classifyMediaKind("Song.FLAC")).toBe("audio");
  });

  it("falls back to audio for an unknown/missing extension (documented default)", () => {
    // Audio is the safe default: it is what every existing Track is, so a
    // mis-classified file keeps today's behavior (mpv `video=no`) instead of
    // opening a video window for something that is not a video.
    expect(classifyMediaKind("notes.txt")).toBe("audio");
    expect(classifyMediaKind("archive.zip")).toBe("audio");
    expect(classifyMediaKind("Track.wma")).toBe("audio");
    expect(classifyMediaKind("noextension")).toBe("audio");
    expect(classifyMediaKind("")).toBe("audio");
    expect(classifyMediaKind("folder")).toBe("audio");
  });

  it("only matches a real trailing extension (not a substring)", () => {
    expect(classifyMediaKind("My.MKV.notes")).toBe("audio");
    expect(classifyMediaKind("mkv")).toBe("audio");
    expect(classifyMediaKind("archive.mp4x")).toBe("audio");
  });

  it("accepts NO video extension beyond the verified list", () => {
    for (const ext of NOT_YET_VIDEO_EXTENSIONS) {
      expect(hasVideoExtension(`Movie${ext}`)).toBe(false);
      expect(classifyMediaKind(`Movie${ext}`)).toBe("audio");
    }
  });
});

describe("hasVideoExtension", () => {
  it("recognizes every enabled video container, case-insensitively", () => {
    expect(hasVideoExtension("Movie.mkv")).toBe(true);
    expect(hasVideoExtension("Movie.MKV")).toBe(true);
    expect(hasVideoExtension("Movie.mp4")).toBe(true);
    expect(hasVideoExtension("Movie.MP4")).toBe(true);
    for (const ext of PLAYABLE_VIDEO_EXTENSIONS) {
      expect(hasVideoExtension(`Movie${ext}`), ext).toBe(true);
      expect(hasVideoExtension(`Movie${ext.toUpperCase()}`), ext).toBe(true);
    }
  });

  it("rejects audio and unknown names", () => {
    expect(hasVideoExtension("Song.mp3")).toBe(false);
    expect(hasVideoExtension("Song.flac")).toBe(false);
    expect(hasVideoExtension("notes.txt")).toBe(false);
    expect(hasVideoExtension("")).toBe(false);
  });
});

describe("isPlayableMediaFile", () => {
  it("accepts both kinds and nothing else", () => {
    for (const name of [
      "Song.mp3",
      "Song.flac",
      "Song.opus",
      "Movie.mkv",
      "Movie.MP4",
    ]) {
      expect(isPlayableMediaFile(name), name).toBe(true);
    }
    for (const name of [
      "notes.txt",
      "archive.zip",
      "Track.wma",
      "folder",
      "",
    ]) {
      expect(isPlayableMediaFile(name), name).toBe(false);
    }
  });

  // The library query matches `name contains '.ext'` (substring), so Drive can
  // return a name that never ends with a playable extension. These must stay
  // out of the mirror even though the query surfaced them.
  it("rejects Drive-substring false positives (leaked rows)", () => {
    for (const name of [
      "photo.avif",
      "App.tsx",
      "index.d.ts",
      "bundle.ts.map",
      "rec.3gpp",
      "rec.3g2",
      "render.mpeg4",
      "Holiday.movie",
      "Holiday.MOVIE",
      "VIDEO_TS.vobs",
    ]) {
      expect(isPlayableMediaFile(name), name).toBe(false);
    }
  });

  it("does not over-narrow: legit names that merely contain a protected token pass", () => {
    expect(isPlayableMediaFile("documentary.about.movies.mkv")).toBe(true);
    expect(isPlayableMediaFile("movie.MKV")).toBe(true);
    // '.ts' is enabled, so a real .ts sample must pass: the exclusion clause is
    // narrowed to .tsx/.d.ts/.ts.map/.tsv, never '.ts' itself.
    expect(isPlayableMediaFile("clip.ts")).toBe(true);
    expect(hasVideoExtension("clip.ts")).toBe(true);
  });

  it("accepts every enabled container as a playable media file", () => {
    for (const ext of PLAYABLE_VIDEO_EXTENSIONS) {
      expect(isPlayableMediaFile(`Movie${ext}`), ext).toBe(true);
    }
  });

  // '.ogv' (video/ogg) vs '.ogg' (audio/ogg): distinct suffixes in both
  // directions — the one asymmetry the container audit called clean. Enabling
  // the video container must not swallow the audio one, and vice versa.
  it("keeps '.ogv' video and '.ogg' audio apart", () => {
    expect(hasVideoExtension("movie.ogv")).toBe(true);
    expect(classifyMediaKind("movie.ogv")).toBe("video");
    expect(isPlayableMediaFile("movie.ogv")).toBe(true);

    expect(hasVideoExtension("song.ogg")).toBe(false);
    expect(classifyMediaKind("song.ogg")).toBe("audio");
    expect(isPlayableMediaFile("song.ogg")).toBe(true);
  });

  // With '.ts' enabled, a `.d.ts` name genuinely ends with an enabled video
  // extension. `classifyMediaKind` stays an endsWith-only predicate (that is
  // the documented single classification authority), so such a name is
  // classified video IF it ever reaches a Track — but `isPlayableMediaFile`
  // keeps it out of the library, which is the gate every ingest path uses.
  it("rejects noise names at the ingest gate, even when they end with an enabled extension", () => {
    for (const name of [
      "index.d.ts",
      "photo.avif",
      "rec.3gpp",
      "render.mpeg4",
      "Holiday.movie",
      "VIDEO_TS.vobs",
    ]) {
      expect(isPlayableMediaFile(name), name).toBe(false);
      expect(isVideoNameNoise(name), name).toBe(true);
    }
    // '.tsx' does not end in '.ts', so it never even classifies as video.
    expect(classifyMediaKind("App.tsx")).toBe("audio");
    expect(classifyMediaKind("index.d.ts")).toBe("video");
  });
});
