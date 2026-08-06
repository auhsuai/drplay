import { describe, it, expect } from "vitest";
import {
  PLAYABLE_AUDIO_EXTENSIONS,
  getAudioQuery,
  getFolderAudioQuery,
  getAudioFilesQuery,
  hasAudioExtension,
  isAudioFile,
} from "./audioQuery";

// Query contract (Task 1 — hide-unplayable-formats): only formats Chromium /
// WebView2 can decode may sync (mp3/flac/wav/ogg/m4a/aac/opus). The
// `mimeType contains 'audio/'` clause is gone — discrimination is by playable
// extension only (a .wma reports audio/x-ms-wma but cannot play).
const AUDIO_QUERY =
  "trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mp3' or name contains '.flac' or name contains '.wav' or name contains '.ogg' or name contains '.m4a' or name contains '.aac' or name contains '.opus'))";

const FOLDER_AUDIO_QUERY =
  "'abc123' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or (name contains '.mp3' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.flac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wav' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.ogg' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.m4a' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.opus' and (mimeType contains 'audio/' or mimeType='application/octet-stream')))";

const AUDIO_FILES_QUERY =
  "trashed=false and ((name contains '.mp3' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.flac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.wav' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.ogg' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.m4a' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.aac' and (mimeType contains 'audio/' or mimeType='application/octet-stream')) or (name contains '.opus' and (mimeType contains 'audio/' or mimeType='application/octet-stream')))";

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

describe("getAudioFilesQuery", () => {
  it("matches the frozen query contract", () => {
    expect(getAudioFilesQuery()).toBe(AUDIO_FILES_QUERY);
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

    it(`recent query (getAudioFilesQuery) matches ${ext} files stored as audio/mpeg`, () => {
      expect(getAudioFilesQuery()).toContain(expectedClause);
    });
  }

  it("non-playable extensions still never appear in folder/recent queries", () => {
    const folderQuery = getFolderAudioQuery("abc123");
    const filesQuery = getAudioFilesQuery();
    for (const ext of NON_PLAYABLE_EXTENSIONS) {
      expect(folderQuery).not.toContain(ext);
      expect(filesQuery).not.toContain(ext);
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
      expect(AUDIO_FILES_QUERY).not.toContain(ext);
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

  it("rejects non-playable formats even when the mime says audio", () => {
    expect(isAudioFile("audio/x-ms-wma", "song.wma")).toBe(false);
    expect(isAudioFile("audio/x-aiff", "song.aiff")).toBe(false);
  });

  it("rejects non-audio names", () => {
    expect(isAudioFile("application/octet-stream", "song")).toBe(false);
    expect(isAudioFile(undefined, "folder")).toBe(false);
  });
});
