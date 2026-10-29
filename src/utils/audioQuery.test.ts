import { describe, it, expect } from "vitest";
import {
  DRIVE_SUBSTRING_FALSE_POSITIVES,
  PLAYABLE_AUDIO_EXTENSIONS,
  buildNameOnlyClause,
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
  isVideoNameNoise,
} from "./audioQuery";
import { classifyMediaKind, isPlayableMediaFile } from "./mediaKind";

// Query contract: the sync allowlist is the set the shipped libmpv engine can
// decode (mp3/flac/wav/ogg/m4a/aac/opus + wma/aif/aiff/oga/m4b +
// ape/wv/tak/dsf/dff), not the
// WebView2/Chromium codec set. The `mimeType contains 'audio/'` clause is gone
// — discrimination is by playable extension only (a bare `song` with
// audio/mpeg is still rejected).
const AUDIO_QUERY =
  "trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mp3' or name contains '.flac' or name contains '.wav' or name contains '.ogg' or name contains '.m4a' or name contains '.aac' or name contains '.opus' or name contains '.wma' or name contains '.aif' or name contains '.aiff' or name contains '.oga' or name contains '.m4b' or name contains '.ape' or name contains '.wv' or name contains '.tak' or name contains '.dsf' or name contains '.dff'))";

const FOLDER_AUDIO_QUERY =
  "'abc123' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mp3' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.flac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wav' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.ogg' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.m4a' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.opus' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wma' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aif' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aiff' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.oga' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.m4b' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.ape' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wv' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.tak' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.dsf' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.dff' and (mimeType contains 'audio/' or mimeType='application/octet-stream')))";

// Still unsupported: plausible audio-ish names that are genuinely absent from
// the allowlist. This is the negative control proving the predicate stayed an
// explicit allowlist and did not degrade into "matches any audio-ish name".
//   .alac — ALAC is normally carried in .m4a; a bare `.alac` file is not an
//           extension this app accepts.
//   .shn  — Shorten, a legacy lossless format; not enabled.
//   .tta  — TTA/True Audio lossless; not enabled.
//   .mka  — Matroska audio container; never added to either allowlist.
//   .wvx  — WavPack hybrid sidecar spelling; NOT `.wv`, so it must stay out.
//   .tak2 — a fake suffix that merely LOOKS like `.tak`: proving the predicate
//           is `endsWith('.tak')`, not a substring match.
const NON_PLAYABLE_EXTENSIONS = [
  ".alac",
  ".shn",
  ".tta",
  ".mka",
  ".wvx",
  ".tak2",
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
  it("recognizes every playable extension case-insensitively", () => {
    for (const ext of PLAYABLE_AUDIO_EXTENSIONS) {
      expect(hasAudioExtension(`song${ext}`), ext).toBe(true);
    }
    expect(hasAudioExtension("song.MP3")).toBe(true);
    expect(hasAudioExtension("song.M4A")).toBe(true);
    expect(hasAudioExtension("song.WMA")).toBe(true);
    expect(hasAudioExtension("song.AIFF")).toBe(true);
    expect(hasAudioExtension("song.OGA")).toBe(true);
    expect(hasAudioExtension("song.M4B")).toBe(true);
    expect(hasAudioExtension("song.APE")).toBe(true);
    expect(hasAudioExtension("song.WV")).toBe(true);
    expect(hasAudioExtension("song.TAK")).toBe(true);
    expect(hasAudioExtension("song.DSF")).toBe(true);
    expect(hasAudioExtension("song.DFF")).toBe(true);
  });

  it("rejects every remaining non-playable audio extension (alac/shn/tta/mka/wvx/tak2)", () => {
    for (const ext of NON_PLAYABLE_EXTENSIONS) {
      expect(hasAudioExtension(`song${ext}`)).toBe(false);
    }
  });

  it("accepts both .aif and .aiff (prefix overlap is harmless: both are audio)", () => {
    expect(hasAudioExtension("t.aif")).toBe(true);
    expect(hasAudioExtension("t.AIF")).toBe(true);
    expect(hasAudioExtension("t.aiff")).toBe(true);
    expect(hasAudioExtension("t.AIFF")).toBe(true);
    // '.aiff' also ends with the '.aif' clause — expected, and still audio.
    expect(hasAudioExtension("t.aiff") && hasAudioExtension("t.aif")).toBe(
      true,
    );
    expect(PLAYABLE_AUDIO_EXTENSIONS).toContain(".aif");
    expect(PLAYABLE_AUDIO_EXTENSIONS).toContain(".aiff");
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

// One test per enabled container: the runtime predicate, the media-kind
// classification and the discovery clause must all agree, otherwise the file
// is either invisible (no query clause) or unplayable (classified as video).
describe("enabled audio containers", () => {
  for (const ext of PLAYABLE_AUDIO_EXTENSIONS) {
    it(`discovers and classifies ${ext} as audio`, () => {
      expect(hasAudioExtension(`Song${ext}`)).toBe(true);
      expect(hasAudioExtension(`Song${ext.toUpperCase()}`)).toBe(true);
      expect(isAudioFile(undefined, `Song${ext}`)).toBe(true);
      expect(classifyMediaKind(`Song${ext}`)).toBe("audio");
      expect(classifyMediaKind(`Song${ext.toUpperCase()}`)).toBe("audio");
      expect(isPlayableMediaFile(`Song${ext}`)).toBe(true);
      expect(isPlayableMediaFile(`Song${ext.toUpperCase()}`)).toBe(true);
      expect(getAudioQuery()).toContain(`name contains '${ext}'`);
      expect(getMediaQuery()).toContain(`name contains '${ext}'`);
    });
  }
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
    expect(isAudioFile("audio/x-monkeys-audio", "song.shn")).toBe(false);
    expect(isAudioFile("audio/x-wavpack", "song.wvx")).toBe(false);
  });

  // .ape/.wv/.tak/.dsf/.dff: extension wins over the mime Drive reports,
  // exactly like every other libmpv container.
  it("accepts .ape/.wv/.tak/.dsf/.dff regardless of the mime Drive reports", () => {
    expect(isAudioFile("audio/x-ape", "song.ape")).toBe(true);
    expect(isAudioFile("audio/x-wavpack", "song.wv")).toBe(true);
    expect(isAudioFile("audio/x-tak", "song.tak")).toBe(true);
    expect(isAudioFile("audio/x-dsf", "song.dsf")).toBe(true);
    expect(isAudioFile("audio/x-dff", "song.dff")).toBe(true);
    expect(isAudioFile("application/octet-stream", "song.ape")).toBe(true);
    expect(isAudioFile(undefined, "song.dff")).toBe(true);
  });

  it("accepts .wma/.aiff regardless of the mime Drive reports", () => {
    expect(isAudioFile("audio/x-ms-wma", "song.wma")).toBe(true);
    expect(isAudioFile("audio/x-aiff", "song.aiff")).toBe(true);
    expect(isAudioFile(undefined, "song.wma")).toBe(true);
    expect(isAudioFile("application/octet-stream", "song.aiff")).toBe(true);
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

// Mirror of PLAYABLE_VIDEO_EXTENSIONS (audioQuery.ts), kept in lockstep AND in
// order: mediaKind.test.ts asserts the exported list with an order-sensitive
// toEqual, so .mkv/.mp4 stay first and new containers are appended only after
// they are verified end-to-end on the real transport.
const VIDEO_EXTENSIONS = [
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
] as const;

// Containers that are NOT enabled: mpv can demux some of them, but none has
// been verified end-to-end on this transport, so none may classify as video.
// These are the negative control that the predicate is still an explicit
// allowlist and did not degrade into "matches anything".
//
// `.3g2` is deliberately absent from this list even though it is also not
// enabled: it DOES appear in getVideoQuery() — as the `.3gp` exclusion
// (`not name contains '.3g2'`) — so a `.not.toContain('.3g2')` assertion would
// be false. It is covered separately below.
const NOT_ENABLED_VIDEO_EXTENSIONS = [
  ".divx",
  ".xvid",
  ".m2ts",
  ".mts",
  ".f4v",
  ".rmvb",
  ".rm",
];

describe("getVideoQuery", () => {
  it("matches the verified video containers, mime-agnostic like getAudioQuery", () => {
    const q = getVideoQuery();
    expect(q).toBe(
      "trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mkv' or name contains '.mp4' or (name contains '.webm' and not name contains '.webmanifest') or name contains '.m4v' or (name contains '.mov' and not name contains '.movie') or (name contains '.avi' and not name contains '.avif') or name contains '.wmv' or name contains '.flv' or (name contains '.mpeg' and not name contains '.mpeg4') or (name contains '.mpg' and not name contains '.mpga') or name contains '.ogv' or (name contains '.3gp' and not name contains '.3gpp' and not name contains '.3g2') or (name contains '.vob' and not name contains '.vobs') or name contains '.asf' or (name contains '.ts' and not name contains '.tsx' and not name contains '.d.ts' and not name contains '.ts.map' and not name contains '.tsv')))",
    );
    expect(q).not.toContain("mimeType contains 'video/'");
  });
});

describe("getFolderVideoQuery", () => {
  it("scopes each video extension on video/* OR application/octet-stream", () => {
    const q = getFolderVideoQuery("abc123");
    expect(q).toBe(
      "'abc123' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mkv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mp4' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.webm' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.m4v' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mov' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.avi' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.wmv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.flv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mpeg' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mpg' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.ogv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.3gp' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.vob' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.asf' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.ts' and (mimeType contains 'video/' or mimeType='application/octet-stream')))",
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
      "'abc123' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mp3' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.flac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wav' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.ogg' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.m4a' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.opus' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wma' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aif' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aiff' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.oga' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.m4b' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.ape' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wv' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.tak' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.dsf' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.dff' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.mkv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mp4' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.webm' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.m4v' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mov' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.avi' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.wmv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.flv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mpeg' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.mpg' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.ogv' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.3gp' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.vob' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.asf' and (mimeType contains 'video/' or mimeType='application/octet-stream')) or (name contains '.ts' and (mimeType contains 'video/' or mimeType='application/octet-stream')))",
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
    for (const ext of NOT_ENABLED_VIDEO_EXTENSIONS) {
      expect(hasVideoExtension(`movie${ext}`)).toBe(false);
      expect(getVideoQuery()).not.toContain(ext);
      expect(getFolderVideoQuery("abc123")).not.toContain(ext);
      expect(getMediaQuery()).not.toContain(ext);
      expect(getFolderMediaQuery("abc123")).not.toContain(ext);
    }
  });

  // '.3g2' is not enabled, but it DOES occur in the video query — as one of
  // the '.3gp' exclusions. Enabling it would require removing that exclusion,
  // so pin both halves: the suffix is not video, and its only appearance is
  // the exclusion clause.
  it("keeps '.3g2' excluded-and-disabled rather than silently enabled", () => {
    expect(hasVideoExtension("clip.3g2")).toBe(false);
    expect(classifyMediaKind("clip.3g2")).toBe("audio");
    expect(isPlayableMediaFile("clip.3g2")).toBe(false);
    expect(getVideoQuery()).toContain("not name contains '.3g2'");
    expect(getVideoQuery()).not.toContain("name contains '.3g2' or");
  });
});

// One test per enabled container: the runtime predicate, the media-kind
// classification and the discovery clause must all agree, otherwise the file is
// either invisible (no query clause) or unplayable (classified as audio).
describe("enabled video containers", () => {
  for (const ext of VIDEO_EXTENSIONS) {
    it(`discovers and classifies ${ext} as video`, () => {
      expect(hasVideoExtension(`Movie${ext}`)).toBe(true);
      expect(hasVideoExtension(`Movie${ext.toUpperCase()}`)).toBe(true);
      expect(classifyMediaKind(`Movie${ext}`)).toBe("video");
      expect(classifyMediaKind(`Movie${ext.toUpperCase()}`)).toBe("video");
      expect(isPlayableMediaFile(`Movie${ext}`)).toBe(true);
      expect(isPlayableMediaFile(`Movie${ext.toUpperCase()}`)).toBe(true);
      expect(getVideoQuery()).toContain(`name contains '${ext}'`);
      expect(getMediaQuery()).toContain(`name contains '${ext}'`);
      expect(isVideoFile(undefined, `Movie${ext}`)).toBe(true);
    });
  }

  it("keeps the '.ts' exclusions inside its own clause", () => {
    const exclusions = DRIVE_SUBSTRING_FALSE_POSITIVES[".ts"] ?? [];
    expect(exclusions).toEqual([".tsx", ".d.ts", ".ts.map", ".tsv"]);
    // The whole clause, exclusions included, must be emitted verbatim.
    const clause = buildNameOnlyClause(".ts", DRIVE_SUBSTRING_FALSE_POSITIVES);
    expect(clause.startsWith("(name contains '.ts'")).toBe(true);
    for (const excluded of exclusions) {
      expect(clause).toContain(`and not name contains '${excluded}'`);
    }
    expect(getVideoQuery()).toContain(clause);
    expect(getMediaQuery()).toContain(clause);
    // The extension itself must never be excluded: a real clip.ts still matches.
    expect(clause).not.toMatch(/not name contains '\.ts'\)/);
  });

  // '.ts' is the one enabled container whose suffix is ALSO the suffix of real
  // source files (`index.d.ts` genuinely ends with '.ts'), so the allowlist
  // alone cannot separate them. The query exclusions narrow Drive's substring
  // match and `isPlayableMediaFile` (the ingest gate) vetoes the rest.
  it("plays a real .ts while rejecting the .ts source-file look-alikes", () => {
    expect(hasVideoExtension("clip.ts")).toBe(true);
    expect(hasVideoExtension("clip.TS")).toBe(true);
    expect(classifyMediaKind("clip.ts")).toBe("video");
    expect(isPlayableMediaFile("clip.ts")).toBe(true);
    expect(isPlayableMediaFile("clip.TS")).toBe(true);

    expect(isPlayableMediaFile("index.d.ts")).toBe(false);
    expect(isPlayableMediaFile("App.tsx")).toBe(false);
    expect(isPlayableMediaFile("bundle.ts.map")).toBe(false);
    expect(isPlayableMediaFile("data.tsv")).toBe(false);
    // '.tsx'/'.ts.map' do not end with '.ts' at all; '.d.ts' does, which is
    // exactly why the runtime veto — not the suffix test — has to catch it.
    expect(hasVideoExtension("App.tsx")).toBe(false);
    expect(hasVideoExtension("bundle.ts.map")).toBe(false);
    expect(hasVideoExtension("index.d.ts")).toBe(true);
    expect(isVideoNameNoise("index.d.ts")).toBe(true);
  });

  // '.ogv' (video/ogg) and '.ogg' (audio/ogg) are distinct suffixes in BOTH
  // directions — the one asymmetry the audit called clean. Now that '.ogv' is
  // enabled, lock the pair: enabling the video container must not swallow the
  // audio one, and the audio container must not classify as video.
  it("separates the '.ogv' video container from the '.ogg' audio container", () => {
    expect(hasVideoExtension("movie.ogv")).toBe(true);
    expect(hasVideoExtension("movie.OGV")).toBe(true);
    expect(classifyMediaKind("movie.ogv")).toBe("video");
    expect(isPlayableMediaFile("movie.ogv")).toBe(true);

    expect(hasVideoExtension("song.ogg")).toBe(false);
    expect(classifyMediaKind("song.ogg")).toBe("audio");
    expect(isPlayableMediaFile("song.ogg")).toBe(true);
    expect(hasAudioExtension("song.ogg")).toBe(true);

    // No cross-matching in the discovery clause either: '.ogg' is an audio
    // clause, not a video one, and '.ogv' is never excluded.
    expect(getVideoQuery()).not.toContain("name contains '.ogg'");
    expect(buildNameOnlyClause(".ogv", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "name contains '.ogv'",
    );
  });
});

// --- Drive substring collision contract (round 1: hardening only) ---------------
// Enabling an extension is NOT the same predicate as the Drive query that
// discovers it: the query is `name contains '.ext'` (substring, anywhere), the
// runtime check is String.endsWith. DRIVE_SUBSTRING_FALSE_POSITIVES is the
// single table of the names that only matched by substring; the same table
// feeds the top-level query clause and the runtime veto.
describe("DRIVE_SUBSTRING_FALSE_POSITIVES", () => {
  it("covers the eight known collisions and nothing else", () => {
    expect(Object.keys(DRIVE_SUBSTRING_FALSE_POSITIVES).sort()).toEqual([
      ".3gp",
      ".avi",
      ".mov",
      ".mpeg",
      ".mpg",
      ".ts",
      ".vob",
      ".webm",
    ]);
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".avi"]).toEqual([".avif"]);
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".ts"]).toEqual([
      ".tsx",
      ".d.ts",
      ".ts.map",
      ".tsv",
    ]);
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".3gp"]).toEqual([".3gpp", ".3g2"]);
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".mpeg"]).toEqual([".mpeg4"]);
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".mov"]).toEqual([".movie"]);
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".vob"]).toEqual([".vobs"]);
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".webm"]).toEqual([".webmanifest"]);
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".mpg"]).toEqual([".mpga"]);
  });

  it("only names collisions of ENABLED extensions", () => {
    for (const ext of Object.keys(DRIVE_SUBSTRING_FALSE_POSITIVES)) {
      expect(hasVideoExtension(`Movie${ext}`), ext).toBe(true);
    }
  });

  it("never excludes the extension itself and never a bare token", () => {
    for (const [ext, suffixes] of Object.entries(
      DRIVE_SUBSTRING_FALSE_POSITIVES,
    )) {
      expect(suffixes.length, ext).toBeGreaterThan(0);
      for (const suffix of suffixes) {
        expect(suffix, ext).not.toBe(ext);
        // A dotted name — excluding a bare token would over-narrow.
        expect(suffix.startsWith("."), `${ext} -> ${suffix}`).toBe(true);
        // The safety property that matters: an exclusion must never be able to
        // drop a name that ends with the extension itself. That holds as soon
        // as the suffix is distinct from the extension (equal length is fine:
        // '.3g2' vs '.3gp' share no suffix, so '.3g2' cannot hide a '.3gp').
        expect(suffix.length, `${ext} -> ${suffix}`).toBeGreaterThanOrEqual(
          ext.length,
        );
        expect(
          `clip${ext}`.includes(suffix),
          `${ext} -> ${suffix} must not match clip${ext}`,
        ).toBe(false);
      }
    }
  });

  // '.3g2' is listed under '.3gp' but is NOT a substring superset of it: the
  // two only share '.3g'. The clause is therefore inert (it excludes nothing
  // that `name contains '.3gp'` would have matched) rather than wrong. Kept
  // because it is pre-existing behavior and harmless; removing it would be a
  // query change with no effect. Pinned here so a future reader does not
  // mistake it for a live collision.
  it("documents the inert '.3g2' exclusion rather than pretending it collides", () => {
    expect(DRIVE_SUBSTRING_FALSE_POSITIVES[".3gp"]).toContain(".3g2");
    expect("clip.3g2".includes(".3gp")).toBe(false);
    expect("clip.3gp".includes(".3g2")).toBe(false);
  });

  it("never lists a bare '.ts' exclusion (a real clip.ts must still match)", () => {
    for (const excluded of DRIVE_SUBSTRING_FALSE_POSITIVES[".ts"] ?? []) {
      expect(excluded).not.toBe(".ts");
    }
  });
});

describe("buildNameOnlyClause (top-level video clause)", () => {
  it("emits the narrow '.ts' exclusion clause, never a bare 'not ... .ts'", () => {
    const clause = buildNameOnlyClause(".ts", DRIVE_SUBSTRING_FALSE_POSITIVES);
    expect(clause).toBe(
      "(name contains '.ts' and not name contains '.tsx' and not name contains '.d.ts' and not name contains '.ts.map' and not name contains '.tsv')",
    );
    expect(clause).not.toMatch(/not name contains '\.ts'\)/);
  });

  it("emits the '.avi' exclusion clause", () => {
    expect(buildNameOnlyClause(".avi", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "(name contains '.avi' and not name contains '.avif')",
    );
  });

  it("emits the remaining exclusion clauses", () => {
    expect(buildNameOnlyClause(".3gp", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "(name contains '.3gp' and not name contains '.3gpp' and not name contains '.3g2')",
    );
    expect(buildNameOnlyClause(".mpeg", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "(name contains '.mpeg' and not name contains '.mpeg4')",
    );
    expect(buildNameOnlyClause(".mov", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "(name contains '.mov' and not name contains '.movie')",
    );
    expect(buildNameOnlyClause(".vob", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "(name contains '.vob' and not name contains '.vobs')",
    );
    expect(buildNameOnlyClause(".webm", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "(name contains '.webm' and not name contains '.webmanifest')",
    );
    expect(buildNameOnlyClause(".mpg", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "(name contains '.mpg' and not name contains '.mpga')",
    );
  });

  it("leaves a collision-free extension as the plain name clause", () => {
    expect(buildNameOnlyClause(".mkv", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "name contains '.mkv'",
    );
    expect(buildNameOnlyClause(".mp4", DRIVE_SUBSTRING_FALSE_POSITIVES)).toBe(
      "name contains '.mp4'",
    );
    expect(buildNameOnlyClause(".flac", undefined)).toBe(
      "name contains '.flac'",
    );
  });

  it("emits an exclusion clause only for the table's extensions", () => {
    const hazardous = Object.keys(DRIVE_SUBSTRING_FALSE_POSITIVES);
    for (const ext of VIDEO_EXTENSIONS) {
      const clause = buildNameOnlyClause(ext, DRIVE_SUBSTRING_FALSE_POSITIVES);
      if (hazardous.includes(ext)) {
        expect(clause, ext).toContain("not name contains");
      } else {
        expect(clause, ext).toBe(`name contains '${ext}'`);
      }
    }
  });
});

describe("isVideoNameNoise", () => {
  it("rejects the Drive-substring false positives, case-insensitively", () => {
    expect(isVideoNameNoise("photo.avif")).toBe(true);
    expect(isVideoNameNoise("photo.AVIF")).toBe(true);
    expect(isVideoNameNoise("App.tsx")).toBe(true);
    expect(isVideoNameNoise("index.d.ts")).toBe(true);
    expect(isVideoNameNoise("bundle.ts.map")).toBe(true);
    expect(isVideoNameNoise("data.tsv")).toBe(true);
    expect(isVideoNameNoise("rec.3gpp")).toBe(true);
    expect(isVideoNameNoise("rec.3g2")).toBe(true);
    expect(isVideoNameNoise("render.mpeg4")).toBe(true);
    expect(isVideoNameNoise("Holiday.movie")).toBe(true);
    expect(isVideoNameNoise("holiday.MOVIE")).toBe(true);
    expect(isVideoNameNoise("VIDEO_TS.vobs")).toBe(true);
    expect(isVideoNameNoise("site.webmanifest")).toBe(true);
    expect(isVideoNameNoise("SITE.WEBMANIFEST")).toBe(true);
  });

  it("keeps real playable names — including a legitimate .ts sample", () => {
    for (const name of [
      "movie.mkv",
      "movie.MKV",
      "movie.mp4",
      "clip.ts",
      "clip.TS",
      "documentary.about.movies.mkv",
      "song.mp3",
      "notes.txt",
      "",
    ]) {
      expect(isVideoNameNoise(name), name).toBe(false);
    }
  });
});
