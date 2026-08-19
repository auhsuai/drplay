// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { DriveFile } from "../db/db";
import { buildTrackInfo } from "./useDriveListing";

// Contract for the extracted trackInfo builder (useDriveListing.ts). The
// streamUnplayable flag is written to the files row's metadata by the metadata
// pipeline (fetchPipeline.ts) for m4a moov-at-end files — the player wiring
// must carry it onto the Track so the native bridge can surface a clear error
// instead of an ambiguous format_error.

function makeFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "f1",
    name: "Song.m4a",
    mimeType: "audio/mp4",
    parentId: "p1",
    trashed: false,
    isFolder: false,
    ...overrides,
  };
}

describe("buildTrackInfo", () => {
  it("carries streamUnplayable from the DriveFile metadata when flagged", () => {
    const track = buildTrackInfo(
      makeFile({ metadata: { format: "m4a", streamUnplayable: true } }),
      "Folder",
      "Song",
    );
    expect(track.streamUnplayable).toBe(true);
  });

  it("leaves streamUnplayable undefined when metadata is absent (best-effort)", () => {
    const track = buildTrackInfo(makeFile(), "Folder", "Song");
    expect(track.streamUnplayable).toBeUndefined();
  });

  it("leaves streamUnplayable undefined for a non-flagged metadata object", () => {
    const track = buildTrackInfo(
      makeFile({ metadata: { format: "mp3" } }),
      "Folder",
      "Song",
    );
    expect(track.streamUnplayable).toBeUndefined();
  });

  it("builds the track identity fields the player consumes", () => {
    const track = buildTrackInfo(makeFile(), "Folder", "Song");
    expect(track).toMatchObject({
      id: "f1",
      title: "Song",
      artist: "",
      streamUrl: "",
      originalName: "Song.m4a",
      parentId: "p1",
      parentName: "Folder",
    });
  });
});
