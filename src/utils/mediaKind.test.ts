import { describe, it, expect } from "vitest";
import { hasVideoExtension } from "./audioQuery";
import {
  classifyMediaKind,
  isPlayableMediaFile,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  PLAYABLE_VIDEO_EXTENSIONS,
} from "./mediaKind";

// The video allowlist is deliberately tiny in this phase: exactly the two
// containers the shipped mpv sidecar was verified to open over the existing
// localhost Range proxy (probe.mkv + probe.mp4 in the investigation report).
// Everything else — including other real video containers — must stay OUT
// until it is verified on the same transport, so the list is asserted exactly
// and never widened by a "close enough" extension.
const ACCEPTED_VIDEO_EXTENSIONS = [".mkv", ".mp4"];

// Containers/codecs mpv can open that this phase has NOT verified over the
// proxy. Each one must classify as audio (the documented default), i.e. it
// must not enter the library as video.
const NOT_YET_VIDEO_EXTENSIONS = [
  ".avi",
  ".mov",
  ".webm",
  ".wmv",
  ".flv",
  ".m4v",
  ".mpeg",
  ".mpg",
  ".3gp",
  ".ts",
  ".ogv",
  ".vob",
  ".divx",
];

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
  it("is exactly the two verified containers, in order", () => {
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
  it("classifies the two video containers as video", () => {
    // Compared against the literal "video", not the constant: a broken
    // export would then fail loudly instead of passing on undefined===undefined.
    expect(classifyMediaKind("Movie.mkv")).toBe("video");
    expect(classifyMediaKind("Movie.mp4")).toBe("video");
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

  it("accepts NO video extension beyond the two verified ones", () => {
    for (const ext of NOT_YET_VIDEO_EXTENSIONS) {
      expect(hasVideoExtension(`Movie${ext}`)).toBe(false);
      expect(classifyMediaKind(`Movie${ext}`)).toBe("audio");
    }
  });
});

describe("hasVideoExtension", () => {
  it("recognizes exactly the verified video containers, case-insensitively", () => {
    expect(hasVideoExtension("Movie.mkv")).toBe(true);
    expect(hasVideoExtension("Movie.MKV")).toBe(true);
    expect(hasVideoExtension("Movie.mp4")).toBe(true);
    expect(hasVideoExtension("Movie.MP4")).toBe(true);
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
});
