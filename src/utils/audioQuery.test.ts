import { describe, it, expect } from "vitest";
import {
  PLAYABLE_AUDIO_EXTENSIONS,
  getAudioQuery,
  getFolderAudioQuery,
  getMediaQuery,
  getFolderMediaQuery,
  getFolderVideoQuery,
  getVideoQuery,
  hasAudioExtension,
  hasVideoExtension,
  isAudioFile,
  isVideoFile,
} from "./audioQuery";

// Query contract (Task 1 — hide-unplayable-formats): only formats Chromium /
// WebView2 can decode may sync (mp3/flac/wav/ogg/m4a/aac/opus). The
// `mimeType contains 'audio/'` clause is gone — discrimination is by playable
// extension only (a .wma reports audio/x-ms-wma but cannot play).
const AUDIO_QUERY =
  "trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mp3' or name contains '.flac' or name contains '.wav' or name contains '.ogg' or name contains '.m4a' or name contains '.aac' or name contains '.opus'))";

const FOLDER_AUDIO_QUERY =
  "'abc123' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mp3' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.flac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wav' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.ogg' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.m4a' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.opus' and (mimeType contains 'audio/' or mimeType='application/octet-stream')))";

const NON_PLAYABLE_EXTENSIONS = [
  ".wma",
  ".aiff",
  ".alac",
  ".ape",
  ".dsf",
  ".dff",
  ".wv",
  ".tak",
];

describe("getAudioQuery", () => {
  it("matches the frozen query contract (playable-only)", () => {
    expect(getAudioQuery()).toBe(AUDIO_QUERY);
  });
});

describe("getFolderAudioQuery", () => {
  it("matches the frozen query contract for a folder id", () => {
    expect(getFolderAudioQuery("abc123")).toBe(FOLDER_AUDIO_QUERY);
  });
});

describe("folder/recent query keeps audio/mpeg coverage (regression v2)", () => {
  // A Drive upload via the web UI or app stores .mp3 as audio/mpeg, not
  // application/octet-stream. v1 dropped the `mimeType contains 'audio/'`
  // clause and these files silently stopped matching folder/recent queries.
  // Each per-extension clause must now be: name contains '.ext' AND
  // (mimeType contains 'audio/' OR mimeType='application/octet-stream').
  for (const ext of PLAYABLE_AUDIO_EXTENSIONS) {
    const expectedClause = `name contains '${ext}' and (mimeType contains 'audio/' or mimeType='application/octet-stream')`;

    it(`folder query matches ${ext} files stored as audio/mpeg`, () => {
      expect(getFolderAudioQuery("abc123")).toContain(expectedClause);
    });
  }

  it("non-playable extensions never appear in the folder query", () => {
    const folderQuery = getFolderAudioQuery("abc123");
    for (const ext of NON_PLAYABLE_EXTENSIONS) {
      expect(folderQuery).not.toContain(ext);
    }
  });

  it("top-level getAudioQuery stays mime-agnostic (name-only, as in v1)", () => {
    expect(getAudioQuery()).not.toContain("mimeType contains 'audio/'");
    expect(getAudioQuery()).not.toContain("application/octet-stream");
  });
});

describe("hasAudioExtension", () => {
  it("recognizes the 7 playable extensions case-insensitively", () => {
    expect(hasAudioExtension("song.mp3")).toBe(true);
    expect(hasAudioExtension("song.MP3")).toBe(true);
    expect(hasAudioExtension("song.flac")).toBe(true);
    expect(hasAudioExtension("song.wav")).toBe(true);
    expect(hasAudioExtension("song.ogg")).toBe(true);
    expect(hasAudioExtension("song.m4a")).toBe(true);
    expect(hasAudioExtension("song.aac")).toBe(true);
    expect(hasAudioExtension("song.opus")).toBe(true);
  });

  it("rejects every non-playable audio extension (wma/aiff/alac/ape/dsf/dff/wv/tak)", () => {
    for (const ext of NON_PLAYABLE_EXTENSIONS) {
      expect(hasAudioExtension(`song${ext}`)).toBe(false);
    }
  });

  it("rejects non-audio names", () => {
    expect(hasAudioExtension("folder")).toBe(false);
    expect(hasAudioExtension("song.mp4")).toBe(false);
    expect(hasAudioExtension("song.txt")).toBe(false);
    expect(hasAudioExtension("")).toBe(false);
  });

  it("PLAYABLE_AUDIO_EXTENSIONS covers every ext used in the queries", () => {
    for (const ext of PLAYABLE_AUDIO_EXTENSIONS) {
      expect(AUDIO_QUERY).toContain(`name contains '${ext}'`);
    }
  });

  it("non-playable extensions never appear in any sync query", () => {
    for (const ext of NON_PLAYABLE_EXTENSIONS) {
      expect(AUDIO_QUERY).not.toContain(ext);
      expect(FOLDER_AUDIO_QUERY).not.toContain(ext);
    }
  });
});

describe("isAudioFile", () => {
  it("is extension-based only: playable extension wins regardless of mime", () => {
    expect(isAudioFile(undefined, "song.mp3")).toBe(true);
    expect(isAudioFile("application/octet-stream", "song.mp3")).toBe(true);
    expect(isAudioFile("audio/mpeg", "song.mp3")).toBe(true);
  });

  it("rejects audio mime without a playable extension (deliberate edge)", () => {
    expect(isAudioFile("audio/mpeg", "song")).toBe(false);
    expect(isAudioFile("audio/flac", "noext")).toBe(false);
  });

  it("rejects non-playable extensions even when the mime says audio", () => {
    expect(isAudioFile("audio/x-ms-wma", "song.wma")).toBe(false);
    expect(isAudioFile("audio/x-aiff", "song.aiff")).toBe(false);
  });

  it("rejects non-audio names", () => {
    expect(isAudioFile("application/octet-stream", "song")).toBe(false);
    expect(isAudioFile(undefined, "folder")).toBe(false);
  });

  // The audio allowlist is NOT widened by the video phase: a video container
  // is a different media kind, and the audio helpers must keep saying so. This
  // is the pre-existing `song.mp4` assertion, restated here as the explicit
  // audio/video separation contract.
  it("a video container is NOT audio (the audio allowlist is not widened)", () => {
    expect(hasAudioExtension("movie.mp4")).toBe(false);
    expect(hasAudioExtension("movie.mkv")).toBe(false);
    expect(isAudioFile("video/mp4", "movie.mp4")).toBe(false);
    expect(isAudioFile("video/x-matroska", "movie.mkv")).toBe(false);
  });
});

// --- Video counterpart (Phase A) -------------------------------------------------
// The video allowlist is ADDITIVE and SEPARATE: audio queries keep their exact
// shape (frozen above), video queries are built the same way, and the union
// query is what the library/browse paths use so movies actually show up.

const VIDEO_EXTENSIONS = [".mkv", ".mp4"] as const;

describe("getVideoQuery", () => {
  it("matches the two verified video containers, mime-agnostic like getAudioQuery", () => {
    const q = getVideoQuery();
    expect(q).toBe(
      "trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mkv' or name contains '.mp4'))",
    );
    expect(q).not.toContain("mimeType contains 'video/'");
  });
});

describe("getFolderVideoQuery", () => {
  it("scopes each video extension on video/* OR application/octet-stream", () => {
    const q = getFolderVideoQuery("abc123");
    expect(q).toBe(
      "'abc123' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mkv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mp4' and (mimeType contains 'video/' or mimeType='application/octet-stream')))",
    );
  });
});

describe("getMediaQuery (library union)", () => {
  it("contains every audio AND every video extension", () => {
    const q = getMediaQuery();
    for (const ext of PLAYABLE_AUDIO_EXTENSIONS) {
      expect(q).toContain(`name contains '${ext}'`);
    }
    for (const ext of VIDEO_EXTENSIONS) {
      expect(q).toContain(`name contains '${ext}'`);
    }
    expect(
      q.startsWith(
        "trashed=false and (mimeType='application/vnd.google-apps.folder' or (",
      ),
    ).toBe(true);
  });

  it("keeps the audio clause byte-identical to getAudioQuery (union only appends)", () => {
    const audio = getAudioQuery();
    const union = getMediaQuery();
    const audioNameClause = audio.slice(
      audio.indexOf("or (") + "or (".length,
      audio.length - 2,
    );
    expect(union).toContain(audioNameClause);
  });

  it("still excludes every non-playable audio extension", () => {
    const q = getMediaQuery();
    for (const ext of NON_PLAYABLE_EXTENSIONS) {
      expect(q).not.toContain(ext);
    }
  });

  it("stays mime-agnostic at the top level (mirrors getAudioQuery)", () => {
    expect(getMediaQuery()).not.toContain("mimeType contains 'audio/'");
    expect(getMediaQuery()).not.toContain("application/octet-stream");
  });
});

describe("getFolderMediaQuery (folder union)", () => {
  it("matches the frozen union contract: audio clauses verbatim, then the video clauses", () => {
    expect(getFolderMediaQuery("abc123")).toBe(
      "'abc123' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mp3' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.flac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wav' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.ogg' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.m4a' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.opus' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.mkv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mp4' and (mimeType contains 'video/' or mimeType='application/octet-stream')))",
    );
  });

  it("keeps the whole audio query as a prefix (union only appends the video clauses)", () => {
    const audio = getFolderAudioQuery("abc123");
    const union = getFolderMediaQuery("abc123");
    // getFolderAudioQuery closes with "))"; the union replaces the final ")".
    expect(union.startsWith(audio.slice(0, -1))).toBe(true);
  });

  it("still excludes every non-playable audio extension", () => {
    const q = getFolderMediaQuery("abc123");
    for (const ext of NON_PLAYABLE_EXTENSIONS) {
      expect(q).not.toContain(ext);
    }
  });
});

describe("hasVideoExtension / isVideoFile", () => {
  it("is extension-based only, case-insensitively", () => {
    expect(hasVideoExtension("movie.mkv")).toBe(true);
    expect(hasVideoExtension("movie.MKV")).toBe(true);
    expect(hasVideoExtension("movie.mp4")).toBe(true);
    expect(hasVideoExtension("movie.MP4")).toBe(true);
    expect(isVideoFile(undefined, "movie.mp4")).toBe(true);
    expect(isVideoFile("video/mp4", "movie.mp4")).toBe(true);
    expect(isVideoFile("application/octet-stream", "movie.mkv")).toBe(true);
  });

  it("rejects audio containers (a file is one kind, never both)", () => {
    for (const ext of PLAYABLE_AUDIO_EXTENSIONS) {
      expect(hasVideoExtension(`song${ext}`)).toBe(false);
      expect(isVideoFile("audio/mpeg", `song${ext}`)).toBe(false);
    }
  });

  it("rejects a video mime without a playable extension (deliberate edge)", () => {
    expect(isVideoFile("video/mp4", "movie")).toBe(false);
    expect(hasVideoExtension("movie")).toBe(false);
  });

  it("accepts no other video container in this phase", () => {
    for (const ext of [
      ".avi",
      ".mov",
      ".webm",
      ".wmv",
      ".flv",
      ".m4v",
      ".ts",
    ]) {
      expect(hasVideoExtension(`movie${ext}`)).toBe(false);
      expect(getVideoQuery()).not.toContain(ext);
      expect(getFolderVideoQuery("abc123")).not.toContain(ext);
      expect(getMediaQuery()).not.toContain(ext);
      expect(getFolderMediaQuery("abc123")).not.toContain(ext);
    }
  });
});
