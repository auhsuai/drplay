import { describe, it, expect } from "vitest";
import {
  AUDIO_EXTENSIONS,
  getAudioQuery,
  getFolderAudioQuery,
  getAudioFilesQuery,
  hasAudioExtension,
  isAudioFile,
} from "./audioQuery";

const AUDIO_QUERY =
  "trashed=false and (mimeType='application/vnd.google-apps.folder' or mimeType contains 'audio/' or (name contains '.mp3' or name contains '.flac' or name contains '.wav' or name contains '.ogg' or name contains '.m4a' or name contains '.aac' or name contains '.opus' or name contains '.wma' or name contains '.aiff' or name contains '.alac' or name contains '.ape' or name contains '.dsf' or name contains '.dff' or name contains '.wv' or name contains '.tak'))";

const FOLDER_AUDIO_QUERY =
  "'abc123' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or mimeType contains 'audio/' or (mimeType='application/octet-stream' and name contains '.mp3') or (mimeType='application/octet-stream' and name contains '.flac') or (mimeType='application/octet-stream' and name contains '.wav') or (mimeType='application/octet-stream' and name contains '.ogg') or (mimeType='application/octet-stream' and name contains '.m4a') or (mimeType='application/octet-stream' and name contains '.aac') or (mimeType='application/octet-stream' and name contains '.opus') or (mimeType='application/octet-stream' and name contains '.wma') or (mimeType='application/octet-stream' and name contains '.aiff') or (mimeType='application/octet-stream' and name contains '.alac') or (mimeType='application/octet-stream' and name contains '.ape') or (mimeType='application/octet-stream' and name contains '.dsf') or (mimeType='application/octet-stream' and name contains '.dff') or (mimeType='application/octet-stream' and name contains '.wv') or (mimeType='application/octet-stream' and name contains '.tak'))";

const AUDIO_FILES_QUERY =
  "trashed=false and (mimeType contains 'audio/' or (mimeType='application/octet-stream' and name contains '.mp3') or (mimeType='application/octet-stream' and name contains '.flac') or (mimeType='application/octet-stream' and name contains '.wav') or (mimeType='application/octet-stream' and name contains '.ogg') or (mimeType='application/octet-stream' and name contains '.m4a') or (mimeType='application/octet-stream' and name contains '.aac') or (mimeType='application/octet-stream' and name contains '.opus') or (mimeType='application/octet-stream' and name contains '.wma') or (mimeType='application/octet-stream' and name contains '.aiff') or (mimeType='application/octet-stream' and name contains '.alac') or (mimeType='application/octet-stream' and name contains '.ape') or (mimeType='application/octet-stream' and name contains '.dsf') or (mimeType='application/octet-stream' and name contains '.dff') or (mimeType='application/octet-stream' and name contains '.wv') or (mimeType='application/octet-stream' and name contains '.tak'))";

describe("getAudioQuery", () => {
  it("matches the frozen query contract", () => {
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

describe("hasAudioExtension", () => {
  it("recognizes known audio extensions case-insensitively", () => {
    expect(hasAudioExtension("song.mp3")).toBe(true);
    expect(hasAudioExtension("song.MP3")).toBe(true);
    expect(hasAudioExtension("song.flac")).toBe(true);
    expect(hasAudioExtension("song.tak")).toBe(true);
  });

  it("rejects non-audio names", () => {
    expect(hasAudioExtension("folder")).toBe(false);
    expect(hasAudioExtension("song.mp4")).toBe(false);
    expect(hasAudioExtension("song.txt")).toBe(false);
    expect(hasAudioExtension("")).toBe(false);
  });

  it("AUDIO_EXTENSIONS covers every ext used in the queries", () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(AUDIO_QUERY).toContain(`name contains '${ext}'`);
    }
  });
});

describe("isAudioFile", () => {
  it("accepts audio mimeTypes regardless of name", () => {
    expect(isAudioFile("audio/mpeg", "song")).toBe(true);
    expect(isAudioFile("audio/flac", "noext")).toBe(true);
  });

  it("falls back to extension check for non-audio mimeTypes", () => {
    expect(isAudioFile(undefined, "song.mp3")).toBe(true);
    expect(isAudioFile("application/octet-stream", "song.mp3")).toBe(true);
    expect(isAudioFile("application/octet-stream", "song")).toBe(false);
    expect(isAudioFile(undefined, "folder")).toBe(false);
  });
});
